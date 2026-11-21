/* 由 tools/dwrite-probe/vtable.py 从 Windows SDK 的 dwrite.h 生成。
 * 不要手改：槽位由头文件里的声明顺序决定，改这里等于改事实。
 * 重新生成：python3 tools/dwrite-probe/vtable.py --emit-c
 */
#ifndef DWRITE_VTABLE_H
#define DWRITE_VTABLE_H

/* IDWriteFactory : public IUnknown */
#define DW_IDWriteFactory_GetSystemFontCollection 3
#define DW_IDWriteFactory_CreateCustomFontCollection 4
#define DW_IDWriteFactory_RegisterFontCollectionLoader 5
#define DW_IDWriteFactory_UnregisterFontCollectionLoader 6
#define DW_IDWriteFactory_CreateFontFileReference 7
#define DW_IDWriteFactory_CreateCustomFontFileReference 8
#define DW_IDWriteFactory_CreateFontFace 9
#define DW_IDWriteFactory_CreateRenderingParams 10
#define DW_IDWriteFactory_CreateMonitorRenderingParams 11
#define DW_IDWriteFactory_CreateCustomRenderingParams 12
#define DW_IDWriteFactory_RegisterFontFileLoader 13
#define DW_IDWriteFactory_UnregisterFontFileLoader 14
#define DW_IDWriteFactory_CreateTextFormat 15
#define DW_IDWriteFactory_CreateTypography 16
#define DW_IDWriteFactory_GetGdiInterop 17
#define DW_IDWriteFactory_CreateTextLayout 18
#define DW_IDWriteFactory_CreateGdiCompatibleTextLayout 19
#define DW_IDWriteFactory_CreateEllipsisTrimmingSign 20
#define DW_IDWriteFactory_CreateTextAnalyzer 21
#define DW_IDWriteFactory_CreateNumberSubstitution 22
#define DW_IDWriteFactory_CreateGlyphRunAnalysis 23

/* IDWriteFontCollection : public IUnknown */
#define DW_IDWriteFontCollection_GetFontFamilyCount 3
#define DW_IDWriteFontCollection_GetFontFamily 4
#define DW_IDWriteFontCollection_FindFamilyName 5
#define DW_IDWriteFontCollection_GetFontFromFontFace 6

/* IDWriteFontList : public IUnknown */
#define DW_IDWriteFontList_GetFontCollection 3
#define DW_IDWriteFontList_GetFontCount 4
#define DW_IDWriteFontList_GetFont 5

/* IDWriteFontFamily : public IDWriteFontList */
#define DW_IDWriteFontFamily_GetFontCollection 3
#define DW_IDWriteFontFamily_GetFontCount 4
#define DW_IDWriteFontFamily_GetFont 5
#define DW_IDWriteFontFamily_GetFamilyNames 6
#define DW_IDWriteFontFamily_GetFirstMatchingFont 7
#define DW_IDWriteFontFamily_GetMatchingFonts 8

/* IDWriteFont : public IUnknown */
#define DW_IDWriteFont_GetFontFamily 3
#define DW_IDWriteFont_GetWeight 4
#define DW_IDWriteFont_GetStretch 5
#define DW_IDWriteFont_GetStyle 6
#define DW_IDWriteFont_IsSymbolFont 7
#define DW_IDWriteFont_GetFaceNames 8
#define DW_IDWriteFont_GetInformationalStrings 9
#define DW_IDWriteFont_GetSimulations 10
#define DW_IDWriteFont_GetMetrics 11
#define DW_IDWriteFont_HasCharacter 12
#define DW_IDWriteFont_CreateFontFace 13

/* IDWriteFontFace : public IUnknown */
#define DW_IDWriteFontFace_GetType 3
#define DW_IDWriteFontFace_GetFiles 4
#define DW_IDWriteFontFace_GetIndex 5
#define DW_IDWriteFontFace_GetSimulations 6
#define DW_IDWriteFontFace_IsSymbolFont 7
#define DW_IDWriteFontFace_GetMetrics 8
#define DW_IDWriteFontFace_GetGlyphCount 9
#define DW_IDWriteFontFace_GetDesignGlyphMetrics 10
#define DW_IDWriteFontFace_GetGlyphIndices 11
#define DW_IDWriteFontFace_TryGetFontTable 12
#define DW_IDWriteFontFace_ReleaseFontTable 13
#define DW_IDWriteFontFace_GetGlyphRunOutline 14
#define DW_IDWriteFontFace_GetRecommendedRenderingMode 15
#define DW_IDWriteFontFace_GetGdiCompatibleMetrics 16
#define DW_IDWriteFontFace_GetGdiCompatibleGlyphMetrics 17

/* IDWriteLocalizedStrings : public IUnknown */
#define DW_IDWriteLocalizedStrings_GetCount 3
#define DW_IDWriteLocalizedStrings_FindLocaleName 4
#define DW_IDWriteLocalizedStrings_GetLocaleNameLength 5
#define DW_IDWriteLocalizedStrings_GetLocaleName 6
#define DW_IDWriteLocalizedStrings_GetStringLength 7
#define DW_IDWriteLocalizedStrings_GetString 8

#endif
