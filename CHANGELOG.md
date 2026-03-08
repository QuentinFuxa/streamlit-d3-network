# Changelog

## 0.1.4 (2026-03-08)

### New Features
- **Compact mode**: new `compact=True` option for embedding in dashboards with reduced chrome
- **Collapsible legend**: legend panel can be collapsed/expanded with a close button
- **i18n support**: `lang` parameter for French (`fr`) and English (`en`) UI strings
- **Toolbar customization**: `toolbar_buttons` parameter to control which toolbar buttons are shown

### Improvements
- **Hierarchical layout**: zone placement uses hierarchical ordering for clearer topology
- **Smooth zone hulls**: Catmull-Rom curves for blob-like zone backgrounds instead of sharp polygons
- **Tooltip positioning**: smarter placement to avoid clipping at edges

## 0.1.0 (2025-12-01)

- Initial release
- D3.js force-directed graph engine with zone-clustered layout
- Node shapes, edge labels, tooltips, search, legend filtering
- Highlight and zoom_to from Python
- Action buttons with bidirectional state (Streamlit v2 component)
- PNG/SVG export
- Selection persistence, keyboard shortcuts (Escape/F)
- Dark/light mode auto-detection
- Minimap, flow particles, stats panel
