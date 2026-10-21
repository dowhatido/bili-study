---
schema: design-pipeline.motion-foundation.v0.1
name: Bili Study motion language
posture: static
primitiveRegistry: design-pipeline.motion-primitives.v1
---

# Bili Study 动效基线

## 动效主张

这是一个高频、长时间使用的学习工具。动效只用于确认状态变化，不装饰阅读内容。页面切换、筛选和列表更新都应瞬时完成，必要时只保留颜色与透明度反馈。

## 动效原则

- 高频操作不等动画。
- 内容阅读区不移动。
- 状态反馈控制在 100 至 160ms。
- 不使用位移入场，不使用弹簧、粒子或持续动画。
- 队列进度只更新文字、颜色和必要的进度条宽度表达。

## 动效词汇

本项目不选择位移、旋转、路径或程序化运动原语。只使用 CSS 颜色、边框和透明度过渡表达按下、聚焦、加载与完成状态。

## 程序化动效

不适用。项目没有 Canvas、WebGL、粒子、路径或程序化生成的运动。

## 运行时策略

仅使用 CSS transition。浏览器不支持过渡时直接显示最终状态。队列进度条使用 `transform: scaleX()`，不触发布局重排。

## 减弱动效

`prefers-reduced-motion: reduce` 的替代与回退是瞬时显示最终状态：取消位移、关键帧和进度条流动效果，保留文字、颜色、边框与状态变化。

## 来源决策

- 采纳：项目现有 140ms 状态反馈和系统字体。
- 未采用：页面切换位移动画、通知条下滑、持续 high-light 动画和任何新增运行时。
