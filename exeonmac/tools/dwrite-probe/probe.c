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
typedef short INT16;
typedef int INT32;
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

/* 用了 float 就必须有 `_fltused`：MSVC 运行时用它标记「本模块需要浮点支持」，
 * 编译器引用它但不定义它（通常由 CRT 提供）。我们不带 CRT，所以自己给。
 * 没有它 lld-link 会报 `undefined symbol: _fltused` —— 报错完全没提浮点，
 * 很容易误判成链接配置问题。 */
int _fltused = 1;

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

/* 十六进制打印。指纹是 32 位无符号数，用十进制读不出差别，也没法贴进日志对账。 */
static void H(unsigned int v) {
    char b[11];
    int i = 10;
    b[i] = 0;
    if (v == 0) { b[--i] = '0'; }
    while (v) {
        unsigned d = v & 15u;
        b[--i] = (char)(d < 10 ? '0' + d : 'a' + (d - 10));
        v >>= 4;
    }
    P("0x"); P(&b[i]);
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

/* ─────────────── 像素层：真的让 DirectWrite 把字栅格化一次 ───────────────
 *
 * ## 为什么「下标非 0」还不够
 *
 * `GetGlyphIndices` 只回答「这张字模里有没有这个码点的槽位」。它回答不了两件事：
 * 那个槽位指向的字形是不是**空轮廓**（占位但没笔画），以及栅格化器会不会因为
 * 渲染模式 / 字体表缺失而画出 `.notdef` 方框。前者在坏字体里很常见，后者在
 * wine 的 dwrite 上完全可能。
 *
 * ## 判据怎么设计才不靠人眼
 *
 * 光数「墨水像素 > 0」不够 —— `.notdef` 方框同样有墨水。本探针的做法是**渲染两次**：
 * 一次目标码点，一次**字形下标 0**（`.notdef` 本身）。两张 alpha 位图的指纹
 * 若相同，说明目标码点画出来的就是缺字框。这不需要参考图、不需要人眼，也不
 * 依赖「这个码点应该长什么样」的先验。
 *
 * 渲染走 `CreateGlyphRunAnalysis` + `CreateAlphaTexture`：纯 DirectWrite，
 * 不经 GDI、不建窗口、不需要 HDC。ALIASED 模式是 1 字节/像素，
 * 比 ClearType 的 3 字节/像素少一层「哪个子像素」的解释空间。
 */

typedef struct { UINT32 left, top, right, bottom; } RECTI32;

/* ─────────────── 渲染模式：ALIASED 只是三种里的一种 ───────────────
 *
 * 第 15 轮只用 `ALIASED` 一种模式就下了「像素对得上」的结论。那条结论的
 * 适用范围比它听起来窄得多：真实 Windows 软件几乎不会用 ALIASED —— GDI 走
 * `CLEARTYPE_QUALITY`，DirectWrite 默认走 `NATURAL`（都是 ClearType 的
 * 子像素路径）。**不同的渲染模式在 DirectWrite 里是不同代码路径**（不同的
 * 光栅化器、不同的字模表解释），所以「ALIASED 画对了」推不出「真实软件也画对了」。
 *
 * 三种模式各自对应一种 alpha 纹理类型：
 *   ALIASED      → DWRITE_TEXTURE_ALIASED_1x1       1 字节/像素
 *   GDI_CLASSIC  → DWRITE_TEXTURE_CLEARTYPE_3x1     3 字节/像素（子像素）
 *   NATURAL      → DWRITE_TEXTURE_CLEARTYPE_3x1     3 字节/像素（子像素）
 *
 * 纹理类型必须与模式匹配，否则 `GetAlphaTextureBounds` 返回
 * `E_INVALIDARG`（不匹配时它不猜，直接拒）。
 *
 * ## 为什么三档都测而不是挑一档
 *
 * 目的是判断「wine 的 dwrite 到底把模式当真了没有」。若三档指纹完全相同，
 * 说明模式参数被忽略，那么第 15 轮的结论可以覆盖全部模式（好消息）；
 * 若不同，则第 15 轮的结论只对 ALIASED 成立，必须补验其余两档（本轮要回答的）。
 * 只测一档无法区分这两种情况 —— 这正是「测了一个值就下结论」的形态。
 */
typedef struct {
    const char *name;   /* 输出里用的短名 */
    int mode;           /* DWRITE_RENDERING_MODE_* */
    int texture;        /* DWRITE_TEXTURE_TYPE_* */
    int width_factor;   /* 纹理宽度相对像素宽度的倍数：1x1 是 1，3x1 是 3 */
} RENDER_MODE;

/* 枚举值取自 `dwrite.h`（`DWRITE_RENDERING_MODE` / `DWRITE_TEXTURE_TYPE`），
 * 顺序即声明顺序，不手抄数字以外的东西。 */
static const RENDER_MODE MODES[] = {
    {"alias", 1, 0, 1},   /* ALIASED / ALIASED_1x1 */
    {"gdic",  2, 1, 3},   /* GDI_CLASSIC / CLEARTYPE_3x1 */
    {"nat",   4, 1, 3},   /* NATURAL / CLEARTYPE_3x1 */
};
#define MODE_COUNT ((int)(sizeof MODES / sizeof MODES[0]))

/* 字形度量。只用 advanceWidth，其余字段必须按头文件顺序占位，
 * 否则结构大小不对、写入会越界。 */
typedef struct {
    INT32 leftSideBearing;
    UINT32 advanceWidth;
    INT32 rightSideBearing;
    INT32 topSideBearing;
    UINT32 advanceHeight;
    INT32 bottomSideBearing;
    INT32 verticalOriginY;
} GLYPH_METRICS;

typedef struct {
    UINT16 designUnitsPerEm;
    UINT16 ascent;
    UINT16 descent;
    UINT16 lineGap;
    UINT16 capHeight;
    UINT16 xHeight;
    INT16 underlinePosition;
    UINT16 underlineThickness;
    INT16 strikethroughPosition;
    UINT16 strikethroughThickness;
} FONT_METRICS;

/* 一次性把某个字形栅格化的结果。`hash` 是 alpha 位图的指纹（FNV-1a），
 * `ink` 是 alpha > 0 的像素数，`w/h` 是纹理尺寸（ClearType 的 w 是像素宽的 3 倍，
 * 因为一个像素有三个子像素）。 */
typedef struct {
    int ok;
    int mode;          /* MODES 的下标 */
    int hrCreate;
    int hrBounds;
    int hrTexture;
    long ink;
    long pixels;
    int w;
    int h;
    unsigned int hash;
} RASTER;

#define EM_SIZE 48.0f          /* DIP；够大，小字号下的 hinting 差异不该混进判据 */
#define MAX_TEXTURE_PIXELS (1024 * 1024)

static unsigned char g_alpha[MAX_TEXTURE_PIXELS];

static RASTER rasterize(void *factory, void *face, UINT16 glyph, int mode_index) {
    RASTER r;
    r.ok = 0; r.mode = mode_index; r.hrCreate = 0; r.hrBounds = 0; r.hrTexture = 0;
    r.ink = 0; r.pixels = 0; r.w = 0; r.h = 0; r.hash = 0;

    const RENDER_MODE m = MODES[mode_index];

    FONT_METRICS fm;
    ((void(__stdcall *)(void *, FONT_METRICS *))
     V(face, DW_IDWriteFontFace_GetMetrics))(face, &fm);
    if (fm.designUnitsPerEm == 0) return r;

    GLYPH_METRICS gm;
    BOOL sideways = 0;
    HRESULT hr = ((HRESULT(__stdcall *)(void *, const UINT16 *, UINT32,
                                        GLYPH_METRICS *, BOOL))
                  V(face, DW_IDWriteFontFace_GetDesignGlyphMetrics))(
        face, &glyph, 1, &gm, sideways);
    if (hr < 0) return r;

    /* 设计单位 → DIP。不换算的话字宽会是 em 的 2048 倍，纹理直接超限。 */
    float advance = (float)gm.advanceWidth * EM_SIZE / (float)fm.designUnitsPerEm;

    /* DWRITE_GLYPH_RUN 的字段顺序必须与头文件一致：fontFace / fontEmSize /
     * glyphCount / glyphIndices / glyphAdvances / glyphOffsets / isSideways / bidiLevel。 */
    struct {
        void *fontFace;
        float fontEmSize;
        UINT32 glyphCount;
        const UINT16 *glyphIndices;
        const float *glyphAdvances;
        const void *glyphOffsets;
        BOOL isSideways;
        UINT32 bidiLevel;
    } run;
    run.fontFace = face;
    run.fontEmSize = EM_SIZE;
    run.glyphCount = 1;
    run.glyphIndices = &glyph;
    run.glyphAdvances = &advance;
    run.glyphOffsets = 0;
    run.isSideways = 0;
    run.bidiLevel = 0;

    /* 参数顺序**照抄 `dwrite.h` 的 `IDWriteFactory::CreateGlyphRunAnalysis`**：
     *
     *   glyphRun, pixelsPerDip, transform, renderingMode, measuringMode,
     *   baselineOriginX, baselineOriginY, out
     *
     * 共 8 个参数，**没有** gridFitMode / antialiasMode —— 那是
     * `IDWriteTextRenderer` 一侧的概念。本轮中途凭记忆写成 10 参数版本，
     * 因为函数指针强转绕过类型检查而编译通过，症状是探针**挂住 180 秒超时**
     * （多出来的两个实参把 renderingMode 挤到 measuringMode 的位置，模式取到
     * 垃圾值）。教训与 15.26⑥ 同一条：**签名只许来自头文件，不许来自记忆。**
     *
     * measuringMode 固定 `NATURAL`（0）：真实软件里 NATURAL 与 GDI_CLASSIC 的
     * 差别只在字宽取整，不影响「画出来是不是同一个字」。 */
    void **analysis = 0;
    hr = ((HRESULT(__stdcall *)(void *, const void *, float, const void *, int,
                                int, float, float, void **))
          V(factory, DW_IDWriteFactory_CreateGlyphRunAnalysis))(
        factory, &run, 1.0f, 0, m.mode, 0, 0.0f, 0.0f, (void **)&analysis);
    r.hrCreate = (int)hr;
    if (hr < 0 || !analysis) return r;

    RECTI32 bounds;
    hr = ((HRESULT(__stdcall *)(void *, int, RECTI32 *))
          V(analysis, DW_IDWriteGlyphRunAnalysis_GetAlphaTextureBounds))(
        analysis, m.texture, &bounds);
    r.hrBounds = (int)hr;
    if (hr < 0) return r;

    long w = (long)bounds.right - (long)bounds.left;
    long h = (long)bounds.bottom - (long)bounds.top;
    r.w = (int)w; r.h = (int)h;
    /* 空包围盒是**合法**答案：字形没有墨水（比如纯空格）。别当成失败。 */
    if (w <= 0 || h <= 0) { r.ok = 1; return r; }

    /* ClearType 的纹理宽度是像素宽的 3 倍（每个像素 3 个子像素，各 1 字节）。
     * 按 1x1 算会把缓冲区开小 3 倍，`CreateAlphaTexture` 直接报
     * `E_INVALIDARG` —— 而报错同样不提「你少算了子像素」。 */
    long bytes = w * (long)m.width_factor * h;
    if (bytes > MAX_TEXTURE_PIXELS) { r.hrTexture = -1; return r; }

    hr = ((HRESULT(__stdcall *)(void *, int, const RECTI32 *, unsigned char *, UINT32))
          V(analysis, DW_IDWriteGlyphRunAnalysis_CreateAlphaTexture))(
        analysis, m.texture, &bounds, g_alpha, (UINT32)bytes);
    r.hrTexture = (int)hr;
    if (hr < 0) return r;

    unsigned int hash = 2166136261u;
    for (long i = 0; i < bytes; i++) {
        if (g_alpha[i]) r.ink++;
        hash = (hash ^ g_alpha[i]) * 16777619u;
    }
    r.hash = hash;
    r.pixels = bytes;
    r.ok = 1;
    return r;
}

/* 把某个码点的栅格化结果打出来，并与 `.notdef` 的指纹比一次。
 *
 * `tofu` 是字形下标 0 那次渲染的结果，作为「缺字长什么样」的参照（同一种模式）。
 * 三档渲染模式各出一行：`raster[cp]` 是 ALIASED（与第 15 轮的输出格式一致，
 * 老判据不用改），另两档标成 `raster[cp@gdic]` / `raster[cp@nat]`。
 */
static void report_one(void *factory, void *face, UINT16 glyph, UINT32 cp,
                       const RASTER *tofu, const char *label, int mode_index,
                       const char *suffix) {
    RASTER r = rasterize(factory, face, glyph, mode_index);
    P("    raster["); P(label); P(suffix); P("]");
    P(" mode="); P(MODES[mode_index].name);
    P(" index="); I((int)glyph);
    P(" ink="); I((int)r.ink); P(" px="); I((int)r.pixels);
    P(" size="); I(r.w); P("x"); I(r.h);
    P(" hash="); H(r.hash);
    if (!r.ok) {
        P(" raster-failed(create="); I(r.hrCreate);
        P(" bounds="); I(r.hrBounds);
        P(" texture="); I(r.hrTexture); P(")\n");
        return;
    }
    /* 三条一起判：
     * ① 有墨水 —— 空轮廓会被抓出来；
     * ② 指纹与 `.notdef` 不同 —— 「画了个方框」会被抓出来；
     * ③ 像素数不是 0 —— 空包围盒是合法的，但对「这个码点该有笔画」来说不是。 */
    if (r.ink == 0) P(" EMPTY");
    else if (tofu->ok && r.hash == tofu->hash) P(" TOFU-SHAPED");
    else P(" ink-present");
    P("\n");
}

static void report_raster(void *factory, void *face, UINT32 cp,
                          const RASTER *tofu_by_mode, const char *label) {
    UINT16 glyph = 0;
    UINT32 p = cp;
    HRESULT hr = ((HRESULT(__stdcall *)(void *, const UINT32 *, UINT32, UINT16 *))
                  V(face, DW_IDWriteFontFace_GetGlyphIndices))(face, &p, 1, &glyph);

    if (hr < 0 || glyph == 0) {
        /* 下标 0 = `.notdef`：没有这个字的槽位，后面的渲染必然画方框，不必再测。
         * 只打一行 —— 三档都会是 notdef，重复三遍只是噪音。 */
        P("    raster["); P(label); P("] index=0 ink=0 notdef\n");
        return;
    }
    static const char *SUFFIX[3] = {"", "@gdic", "@nat"};
    for (int i = 0; i < MODE_COUNT; i++)
        report_one(factory, face, glyph, cp, &tofu_by_mode[i], label, i, SUFFIX[i]);
}

/* 完整走一遍：集合 → 按家族名查 → 取家族 → 取字面 → 查字形覆盖 → 栅格化。
 *
 * `label` 只用于输出，便于把「写之前 / 写之后」两组结果并排看。 */
static void inspect(void **factory, void **collection, const WCHAR *family_name,
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

    /* 像素层：`.notdef`（下标 0）在**每种模式**下各渲染一次当参照，再逐个码点同模式比指纹。
     *
     * 参照必须与目标同模式：ALIASED 的 alpha 是 1 字节/像素、ClearType 是 3 字节/像素
     * （子像素），跨模式的指纹本来就不可能相等 —— 拿 ALIASED 的缺字框去比 ClearType
     * 的字，永远得出「不同」，判据②就永远为真、等于没写。 */
    RASTER tofu_by_mode[MODE_COUNT];
    for (int i = 0; i < MODE_COUNT; i++) {
        tofu_by_mode[i] = rasterize(factory, face, 0, i);
        P("    notdef@"); P(MODES[i].name);
        P(" ink="); I((int)tofu_by_mode[i].ink);
        P(" px="); I((int)tofu_by_mode[i].pixels);
        P(" size="); I(tofu_by_mode[i].w); P("x"); I(tofu_by_mode[i].h);
        if (!tofu_by_mode[i].ok || tofu_by_mode[i].ink == 0)
            P("（无墨水，判据②在该模式下降级）");
        P("\n");
    }
    if (!tofu_by_mode[0].ok || tofu_by_mode[0].ink == 0) {
        /* 苹方的 `.notdef` 是空轮廓（实测 ink=0），所以「指纹与缺字框相同」
         * 这条判据在本机会空转。降级后必须靠下面那条自检码点守住判别力，
         * 否则「渲染成功」会被读成「渲染对了」。 */
        P("    （缺字框无墨水，判别力由 U+10FFFD 自检承担）\n");
    }

    report_raster(factory, face, 0x0041, tofu_by_mode, "A");
    report_raster(factory, face, 0x4E2D, tofu_by_mode, "U+4E2D");
    report_raster(factory, face, 0x9ED1, tofu_by_mode, "U+9ED1");
    /* U+10FFFD 是 Unicode 第 15 平面私用区最后一个码点，任何正常字模都不会
     * 给它字形。它的 index 必须是 0 —— 这条是「缺字确实会被判出来」的机器证据，
     * 不靠 notdef 有墨水。若哪天它返回非 0，说明这张字模的 cmap 有问题，
     * 上面三条 `ink-present` 也就不可信了。 */
    report_raster(factory, face, 0x10FFFD, tofu_by_mode, "U+10FFFD");
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
    inspect(factory, collection, yahei_en, "FindFamilyName[Microsoft YaHei]");
    inspect(factory, collection, yahei_zh, "FindFamilyName[weiruan-yahei]");
    inspect(factory, collection, simsun_en, "FindFamilyName[SimSun]");
    inspect(factory, collection, simsun_zh, "FindFamilyName[songti]");
    inspect(factory, collection, pingfang, "FindFamilyName[PingFang SC]");

    ExitProcess(0);
}
