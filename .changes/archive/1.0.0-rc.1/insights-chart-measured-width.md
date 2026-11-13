---
category: Fixed
---

- **Insights charts render at their true measured width** instead of stretching a fixed 560px SVG across wide cards (which inflated the designed tick text) — width comes from a ResizeObserver-measured container, with the fixed size kept for static/SSR and webviews without ResizeObserver.
- **Chart date labels are pinned to a numeric M/D format** shared by every locale, instead of varying with the app language.

<!-- CN -->
- **洞察图表按实测宽度渲染**：不再把固定 560px 的 SVG 拉伸到宽卡片上（导致设计好的刻度文字被放大）——宽度由 ResizeObserver 实测容器获得，静态/SSR 与不支持 ResizeObserver 的 WebView 仍使用固定尺寸。
- **图表日期标签固定为数字 M/D 格式**：所有语言共用同一格式，不再随应用语言变化。
