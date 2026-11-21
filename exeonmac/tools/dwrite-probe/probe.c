/* DirectWrite 探针 —— 只走 DirectWrite 这条路径（完全不经 GDI），
 * 判断 wine 的 DirectWrite 认不认 font_map 写下的家族名、以及那张字模里
 * 到底有没有中文字形。
 *
 * ## 为什么必须有它
 *
 * `launcher` 的字体替换要回答两个问题，两个都只能实测：
 *
 *   1. 键写进去之后，**DirectWrite 读得到吗**？—— 第 13 轮用本探针的前身答了：
 *      `FontSubstitutes`（HKLM）对它零作用，只有 `HKCU\Software\Wine\Fonts\Replacements`
 *      能让 `FindFamilyName("Microsoft YaHei")` 返回 true。
 *   2. 名字解析到了，**字真的画得出来吗**？—— 这便是本轮新增的一问。
 *      「家族名存在」与「这张字模里有 U+4E2D 的字形」是两件事：别名可以把一个
 *      没有中文字形的拉丁字体登记成「微软雅黑」，名字对了、界面照样方块。
 *
 * ## 为什么手搓 vtable 而不是链接 dwrite.lib 用头文件
 *
 * 目的是「零依赖、可在任意 prefix 里扔进去就跑」：不用 CRT、不用 SDK 头文件，
 * 交叉编成 4 KB 的 PE 直接 `wine c:\probe.exe`。代价是槽位下标要自己写，
 * 而槽位算错没有任何编译期保护（第 13 轮就在这里错过一次：
 * `GetFamilyNames` 属于派生接口，是 slot 6 不是 3）。
 *
 * 所以槽位**不在这里手写**，全部来自 `vtable.h` —— 它由 `vtable.py` 从真实
 * SDK 的 `dwrite.h` 生成，且 `--check` 会与快照对账。改槽位等于改头文件里
 * 的声明顺序，不可能悄悄发生。
 *
 * 编译（见 build.sh）：
 *   clang-cl --target=x86_64-pc-windows-msvc -c -O1 -GS- -fno-builtin
 *   lld-link /nodefaultlib /entry:entry /subsystem:console
 */

#include "vtable.h"

typedef int HRESULT;
typedef unsigned int UINT32;
typedef unsigned short UINT16;
typedef int BOOL;
typedef unsigned long DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;

__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD);
__declspec(dllimport) BOOL __stdcall WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
__declspec(dllimport) int __stdcall WideCharToMultiByte(UINT32, DWORD, const WCHAR *, int,
                                                        char *, int, const char *, BOOL *);
__declspec(dllimport) void __stdcall ExitProcess(UINT32);

/* 取 COM 对象第 n 个 vtable 槽：对象首字是 vtable 指针。 */
#define V(obj, slot) (((void ***)(obj))[0][(slot)])

static HANDLE g_out;

static int slen(const char *s) { int n = 0; while (s[n]) n++; return n; }
static void P(const char *s) { DWORD w = 0; WriteFile(g_out, s, (DWORD)slen(s), &w, 0); }

static void I(int v) {
    char b[16];
    int i = 15;
    b[i] = 0;
    if (v == 0) {
        b[--i] = '0';
    } else {
        int neg = v < 0;
        unsigned u = neg ? (unsigned)(-v) : (unsigned)v;
        while (u) { b[--i] = (char)('0' + u % 10); u /= 10; }
        if (neg) b[--i] = '-';
    }
    P(&b[i]);
}

static void put_wide(const WCHAR *w, int len) {
    char buf[512];
    int n = WideCharToMultiByte(65001, 0, w, len, buf, sizeof buf - 1, 0, 0);
    if (n <= 0) { P("<utf8?>"); return; }
    buf[n] = 0;
    P(buf);
}

typedef struct { unsigned int a; unsigned short b, c; unsigned char d[8]; } GUID;

__declspec(dllimport) HRESULT __stdcall DWriteCreateFactory(int, const GUID *, void **);

/* {b859ee5a-d838-4b5b-a2e8-1adc7d93db48} —— 与 vtable.json 里的 iid 同一来源。 */
static const GUID IID_FACTORY = {0xb859ee5a, 0xd838, 0x4b5b,
                                 {0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48}};

/* 打印 IDWriteLocalizedStrings 的内容（最多 8 条）。 */
static void dump_strings(void *names, const char *indent) {
    UINT32 count = ((UINT32(__stdcall *)(void *))
                    V(names, DW_IDWriteLocalizedStrings_GetCount))(names);
    P(indent); P("count="); I((int)count); P("\n");
    for (UINT32 i = 0; i < count && i < 8; i++) {
        UINT32 len = 0;
        HRESULT hr = ((HRESULT(__stdcall *)(void *, UINT32, UINT32 *))
                      V(names, DW_IDWriteLocalizedStrings_GetStringLength))(names, i, &len);
        if (hr < 0) { P(indent); P("len fail\n"); continue; }
        static WCHAR buf[256];
        if (len > 255) len = 255;
        hr = ((HRESULT(__stdcall *)(void *, UINT32, WCHAR *, UINT32))
              V(names, DW_IDWriteLocalizedStrings_GetString))(names, i, buf, len + 1);
        if (hr < 0) { P(indent); P("string fail\n"); continue; }
        buf[len] = 0;
        P(indent); P("["); I((int)i); P("] "); put_wide(buf, (int)len); P("\n");
    }
}

/* 问这张字模里有没有某个码点的字形。返回 1 = 有，0 = 没有（=.notdef），-1 = 查询失败。
 *
 * `GetGlyphIndices` 的约定：字形下标为 0 表示 `.notdef`（缺字方框）。所以「有」
 * 的判据是「下标非 0」，而不是「调用没失败」—— 缺字时它同样返回 S_OK。 */
static int has_glyph(void *face, UINT32 code_point) {
    UINT32 cp = code_point;
    UINT16 glyph = 0;
    HRESULT hr = ((HRESULT(__stdcall *)(void *, const UINT32 *, UINT32, UINT16 *))
                  V(face, DW_IDWriteFontFace_GetGlyphIndices))(face, &cp, 1, &glyph);
    if (hr < 0) return -1;
    return glyph != 0 ? 1 : 0;
}

/* 打印某个码点在这张字模里的覆盖情况。
 *
 * 拉丁字母与中文各取一个：只测拉丁的话，「装了个没有中文的拉丁字体」也会通过。 */
static void report_glyph(void *face, UINT32 cp, const char *label) {
    int got = has_glyph(face, cp);
    P("    glyph["); P(label); P("]=");
    if (got < 0) P("query-failed");
    else if (got) P("present");
    else P("MISSING");
    P("\n");
}

/* 完整走一遍：集合 → 按家族名查 → 取家族 → 取字面 → 查字形覆盖。
 *
 * `label` 只用于输出，便于把「写之前 / 写之后」两组结果并排看。 */
static void inspect(void **collection, const WCHAR *family_name,
                    const char *label) {
    UINT32 index = 0;
    BOOL exists = 0;
    HRESULT hr = ((HRESULT(__stdcall *)(void *, const WCHAR *, UINT32 *, BOOL *))
                  V(collection, DW_IDWriteFontCollection_FindFamilyName))(
        collection, family_name, &index, &exists);
    P(label); P(" exists="); I((int)exists); P(" index="); I((int)index);
    P(" hr="); I((int)hr); P("\n");
    if (hr < 0 || !exists) return;

    void **family = 0;
    hr = ((HRESULT(__stdcall *)(void *, UINT32, void **))
          V(collection, DW_IDWriteFontCollection_GetFontFamily))(
        collection, index, (void **)&family);
    if (hr < 0 || !family) { P("  family fail hr="); I((int)hr); P("\n"); return; }

    /* 家族里有几个字面（face）。0 个说明只有名字、没有字模 —— 正是「别名指到了
     * 一个不存在的实体」的形态，光看 FindFamilyName 是看不出来的。 */
    UINT32 faces = ((UINT32(__stdcall *)(void *))
                    V(family, DW_IDWriteFontFamily_GetFontCount))(family);
    P("  faceCount="); I((int)faces); P("\n");

    void **names = 0;
    hr = ((HRESULT(__stdcall *)(void *, void **))
          V(family, DW_IDWriteFontFamily_GetFamilyNames))(family, (void **)&names);
    if (hr < 0 || !names) { P("  familyNames fail hr="); I((int)hr); P("\n"); return; }
    dump_strings(names, "  familyName ");

    if (faces == 0) {
        P("  （没有字面，无法查字形覆盖）\n");
        return;
    }

    void **font = 0;
    hr = ((HRESULT(__stdcall *)(void *, UINT32, void **))
          V(family, DW_IDWriteFontFamily_GetFont))(family, 0, (void **)&font);
    if (hr < 0 || !font) { P("  font fail hr="); I((int)hr); P("\n"); return; }

    void **face_names = 0;
    hr = ((HRESULT(__stdcall *)(void *, void **))
          V(font, DW_IDWriteFont_GetFaceNames))(font, (void **)&face_names);
    if (hr >= 0 && face_names) dump_strings(face_names, "  faceName ");

    void **face = 0;
    hr = ((HRESULT(__stdcall *)(void *, void **))
          V(font, DW_IDWriteFont_CreateFontFace))(font, (void **)&face);
    if (hr < 0 || !face) { P("  fontFace fail hr="); I((int)hr); P("\n"); return; }

    report_glyph(face, 0x0041, "A");
    report_glyph(face, 0x4E2D, "U+4E2D");
    report_glyph(face, 0x9ED1, "U+9ED1");
}

void entry(void) {
    g_out = GetStdHandle((DWORD)-11);

    void **factory = 0;
    HRESULT hr = DWriteCreateFactory(0, &IID_FACTORY, (void **)&factory);
    if (hr < 0 || !factory) { P("FATAL factory hr="); I((int)hr); P("\n"); ExitProcess(2); }

    void **collection = 0;
    hr = ((HRESULT(__stdcall *)(void *, void **, BOOL))
          V(factory, DW_IDWriteFactory_GetSystemFontCollection))(
        factory, (void **)&collection, 0);
    if (hr < 0 || !collection) { P("FATAL collection hr="); I((int)hr); P("\n"); ExitProcess(3); }

    UINT32 total = ((UINT32(__stdcall *)(void *))
                    V(collection, DW_IDWriteFontCollection_GetFontFamilyCount))(collection);
    P("familyCount="); I((int)total); P("\n");

    static const WCHAR yahei_en[] = {'M','i','c','r','o','s','o','f','t',' ','Y','a','H','e','i',0};
    static const WCHAR yahei_zh[] = {0x5FAE, 0x8F6F, 0x96C5, 0x9ED1, 0};
    static const WCHAR simsun_zh[] = {0x5B8B, 0x4F53, 0};
    static const WCHAR simsun_en[] = {'S','i','m','S','u','n',0};
    static const WCHAR pingfang[] = {'P','i','n','g','F','a','n','g',' ','S','C',0};

    /* 五个名字，按性质分三组：
     *   Microsoft YaHei / 微软雅黑 —— font_map 的键（英文名与中文名各一，
     *                                第 13 轮的 E 组证明中文键名同样有效）
     *   SimSun / 宋体             —— 第二条常见映射键，同样两种写法各查一次
     *   PingFang SC               —— 映射的目标值，确认目标字体本身在集合里
     *
     * 中文名与英文名要分开查：`Replacements` 是**别名**语义，写哪个名字就只多出
     * 哪个名字，不会自动把两种写法都登记上（本轮实测：E 组写「微软雅黑」，
     * 则中文名 exists=1、英文名 exists=0）。
     */
    inspect(collection, yahei_en, "FindFamilyName[Microsoft YaHei]");
    inspect(collection, yahei_zh, "FindFamilyName[weiruan-yahei]");
    inspect(collection, simsun_en, "FindFamilyName[SimSun]");
    inspect(collection, simsun_zh, "FindFamilyName[songti]");
    inspect(collection, pingfang, "FindFamilyName[PingFang SC]");

    ExitProcess(0);
}
