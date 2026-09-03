# 隐私说明 / Privacy Notice

生效日期：2026-09-02

## 简要说明

Shadowing Studio 是在用户浏览器本地运行的非官方学习工具。扩展不包含广告、用户分析、遥测、账号系统或外部运行时依赖，也不会将字幕上传到开发者或第三方分析服务。

## 扩展处理的数据

扩展在用户主动打开受支持的哔哩哔哩 BV 视频时处理以下信息：

- 当前视频的 BV 号、分P标识、标题和时长。
- 哔哩哔哩播放器提供或已经加载的字幕轨道元数据与字幕正文。
- 用户选择的播放速度、播放模式、练习粒度、界面展开状态和最近的字幕轨道选择。

字幕正文只在当前视频页面和扩展侧栏中处理，不写入浏览器设置。下载的 SRT、TXT、Markdown 或 JSON 文件由浏览器在本地生成。

## 网络访问

- 扩展只会在 `https://www.bilibili.com/video/*` 页面运行。
- 为获得当前视频与字幕信息，扩展会在哔哩哔哩页面环境中请求 `api.bilibili.com` 的播放器接口。
- 字幕文件只允许来自使用 HTTPS 的 `bilibili.com`、其子域名、`hdslb.com` 或其子域名。
- 播放器接口会沿用当前浏览器的哔哩哔哩登录状态；字幕文件请求不携带登录凭据。
- 扩展不会把数据发送给 Shadowing Studio 开发者，也不会连接广告或分析服务。

## 本地存储

扩展使用 `chrome.storage.local` 保存：

- 播放模式、练习粒度和播放速度。
- 视频信息区域的展开偏好。
- 最多 50 条按 BV 号和分P标识记录的字幕轨道选择。

卸载扩展会由浏览器按其自身规则清理这些本地设置。用户也可以通过浏览器扩展管理页清除扩展数据。

## 权限用途

| 权限 | 用途 |
|---|---|
| `sidePanel` | 在视频旁显示专注练习界面。 |
| `storage` | 保存上述本地偏好。 |
| `scripting` | 在当前哔哩哔哩视频页面连接播放器与字幕数据。 |
| `https://www.bilibili.com/*` | 将扩展限制在哔哩哔哩页面范围内。 |

扩展不申请浏览历史、剪贴板、麦克风、摄像头、定位或浏览器下载权限。

## 用户责任与第三方服务

哔哩哔哩页面、账号、视频和字幕受哔哩哔哩自身条款与内容权利约束。用户应仅在法律及内容许可允许的范围内使用或导出字幕。本项目不会绕过登录、付费或其他访问控制。

## 变更与联系

本说明如有实质变化，会在新版本中标明。一般问题可通过 GitHub Issues 提交；安全问题请使用仓库的 **Security → Report a vulnerability** 入口私下报告。

---

## English summary

Shadowing Studio runs locally in the browser. It has no advertising, analytics, telemetry, account system or external runtime dependency. It reads video and subtitle data only on supported Bilibili BV pages, stores a small set of local preferences, and generates subtitle downloads locally. Subtitle text is not sent to the author or to third-party analytics services. Use GitHub private vulnerability reporting for security reports.
