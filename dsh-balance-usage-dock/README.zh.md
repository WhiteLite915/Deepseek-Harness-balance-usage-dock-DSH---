# 余额与用量（Balance \& Usage Dock）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web UI 插件。在对话区底部【性能与用量】左侧显示 DeepSeek 账户余额、今日消耗，以及本会话每次回复的 token 用量柱状图。



运行要求：DSH 桌面版（或组合了 `dsh-host-webserver`、`dsh-session-projection` 与凭据服务的 Web 配置），并已在设置 → 账户中登录 DeepSeek。无第三方依赖，无需构建。

## 功能

* **实时余额**：充值余额 + 赠送额度，每 15 秒刷新；显示口径与账户页完全一致——每个钱包截断到分，标题取两项显示值之和。
* **今日**：当天首次读数以来的消耗，取自账户的累计消费计数器。
* **每次回复的 token 柱状图**：本会话每个回复一根柱子，按该次回复的输出 token 定高，轻重回复一眼可辨；最新一根高亮。
* **悬停详情**：精确账户总额、钱包拆分、本次会话消耗，以及最新回复的 token 总量与输出/输入拆分。

## 安装

1. 在 DSH 侧栏打开 **插件（Plugins）**。
2. 用插件管理器安装本目录（或 Git 地址）。
3. 若列表中未出现，重启 DeepSeek Harness；卸载在同一页面禁用或移除即可。

