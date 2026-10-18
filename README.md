# Overleaf 公网入口

把本机 Overleaf 通过 FRP 接到腾讯云，再由云服务器上的 Nginx 提供 HTTPS。Overleaf 自带协同编辑网页，不需要另写编辑器或将 Overleaf、MongoDB、编译服务搬到云上。

公网入口为 **`https://124.223.191.114:8443/`**。本机 GDELT 的 FRP 客户端使用云端 TCP `7001`，因此 Overleaf 使用安全组中已经放行的 `8443`；这不会改变原有的 `https://124.223.191.114/DSI.html` 网站。

```text
浏览器 --HTTPS :8443--> 腾讯云 Nginx --127.0.0.1:18081--> FRP 服务端 :7000
                                                                    ║ FRP TLS
本机 Overleaf :8080 <-- FRP 客户端 ---------------------------------╝
```

FRP 的 `18081` 只监听腾讯云回环地址，不需要开放公网端口。FRPS 会重启一次，现有 FRP 隧道会短暂重连；原有站点配置和转发端口会保留。

## 首次部署

### 1. 本机 Overleaf 电脑

此前已确认 Overleaf 的 `http://127.0.0.1:8080/status` 返回 HTTP 200。FRP 客户端配置需要有下面这个代理段：

```toml
[[proxies]]
name = "overleaf"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8080
remotePort = 18081
```

本机已有连接到 `124.223.191.114:7000` 的 MultiWorks FRP 客户端，服务为 `frpc.service`，配置文件为 `/etc/frp/frpc.toml`。GDELT 使用另一个客户端 `dsi-frpc.service`，连接云端 `7001`；不要把 Overleaf 配置加到 GDELT 客户端。认证令牌留在本机配置中，不要提交到 Git。

本仓库维护者的本机 Overleaf 电脑已配置好该 FRPC 代理。云端允许端口尚未更新前，FRPC 日志可能显示 `port not allowed`；运行下面的云端脚本后，FRPS 会重启，客户端应自动重新连接。如果没有自动恢复，在本机执行 `sudo systemctl restart frpc.service`。若改在另一台电脑部署 Overleaf，则需将代理段追加到连接云端 `7000` 的 FRPC 配置并重启该客户端。

### 2. 腾讯云服务器

把仓库克隆到服务器（或进入已有克隆目录），然后执行：

```bash
cd /path/to/OLServer
git pull --ff-only
sudo ./deploy/cloud/setup.sh
```

脚本会自动完成这些操作：

- 备份 FRPS 配置和脚本管理的 Nginx 站点文件。
- 在现有 FRPS `allowPorts` 中追加 `18081`，保留 MultiWorks、GDELT 等原有端口。
- 确认 FRP 代理仍绑定 `127.0.0.1`，不将内部转发端口暴露到公网。
- 查找现有 Nginx 配置中的证书，并校验证书包含 IP `124.223.191.114` 且未过期。
- 添加 Nginx HTTPS 监听 `8443`，代理到 `127.0.0.1:18081`。
- 验证 FRPS 和 Nginx 配置后重启 FRPS、平滑重载 Nginx。

脚本需要云服务器已有 Nginx、FRPS、Python 3.11+、OpenSSL，并且云安全组已经允许 TCP `8443`。目前的腾讯云安全组清单已放行该端口。云端 FRPS 默认配置路径为 `/etc/frp/frps.toml`、服务名为 `frps.service`；若实际路径或服务名不同，可这样执行：

```bash
sudo env FRPS_CONFIG=/实际路径/frps.toml FRPS_SERVICE=实际服务名 ./deploy/cloud/setup.sh
```

脚本会尝试复用现有 HTTPS 站点的 IP 证书。如果 Nginx 中没有可用证书，脚本会停止并说明原因，不会改成不安全的 HTTP。可以通过 `OVERLEAF_CERT_FILE` 和 `OVERLEAF_KEY_FILE` 指定有效证书与私钥路径。

例如，证书文件路径为 `/etc/letsencrypt/live/124.223.191.114/` 时：

```bash
sudo env \
  OVERLEAF_CERT_FILE=/etc/letsencrypt/live/124.223.191.114/fullchain.pem \
  OVERLEAF_KEY_FILE=/etc/letsencrypt/live/124.223.191.114/privkey.pem \
  ./deploy/cloud/setup.sh
```

若 FRPS 或 Nginx 配置验证失败，脚本会在重启服务前退出。修改前的 FRPS 和 Nginx 配置备份保存在 `/var/backups/overleaf-frp/`。

## 验证

FRPC 已连接且云端脚本成功运行后，在腾讯云执行：

```bash
curl -i http://127.0.0.1:18081/status
```

应返回 HTTP 200。然后从外部设备打开 **<https://124.223.191.114:8443/>**。Nginx 会处理 Overleaf 的 WebSocket 协作连接和大文件上传。

若当前 Overleaf 安装支持这些设置，将其公开站点地址配置为 `https://124.223.191.114:8443`，并启用 `OVERLEAF_BEHIND_PROXY=true`、`OVERLEAF_SECURE_COOKIE=true`。具体配置文件及应用方式取决于安装类型；旧版本可能使用 `SHARELATEX_` 前缀。[Overleaf 环境变量文档](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/environment-variables)

## Overleaf DeepSeek AI（自托管 Toolkit）

本仓库还包含一个针对当前本机 Overleaf Toolkit 镜像的自定义构建：

- CodeMirror 源码编辑器停顿后请求 DeepSeek FIM 补全；按 `Tab` 接受，按 `Esc` 忽略。
- 选中源码后点击编辑器工具栏里的“AI 修改”，输入自然语言指令，检查 LaTeX 修改预览后再应用。
- 仅站点管理员能在 `/admin` 的 **AI Assistant** 页设置模型、API Key 和功能开关。API Key 在服务端加密存入 MongoDB，不会发给浏览器或显示回管理页面。

补全仅发送光标前最多 1,800 个字符和后最多 800 个字符；选区修改仅发送选中内容及两侧最多 2,000 个字符。请求由本机 Overleaf 后端通过 HTTPS 发给 DeepSeek。每个账户的补全限制为每分钟 45 次，选区修改限制为每分钟 15 次。DeepSeek 的 FIM 接口目前标为 Beta；本实现固定使用 DeepSeek API，补全使用 `deepseek-flash`，选区修改可以在管理页选择 `deepseek-flash` 或 `deepseek-v4-pro`。[DeepSeek FIM 接口](https://api-docs.deepseek.com/guides/fim_completion) [DeepSeek Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)

### 构建并启用

在运行 Overleaf 的本机电脑上，从本仓库根目录执行：

```bash
git pull --ff-only
sudo ./deploy/local/build-overleaf-ai.sh
sudo /opt/overleaf/toolkit/bin/up -d
```

构建脚本只支持本项目当前使用的 Overleaf Toolkit 镜像版本 `6.3.1-with-texlive-full`。脚本会构建 `ofserver/overleaf-ai:6.3.1-with-texlive-full`，备份 Toolkit 的镜像配置，并在 `config/variables.env` 中生成一次性的 `OVERLEAF_AI_SETTINGS_SECRET`。构建成功后执行 `bin/up -d` 才会重启并启用自定义镜像；原 Overleaf 项目和数据库目录会继续使用原有挂载数据。

然后用站点管理员账号登录 Overleaf，打开 `/admin` → **AI Assistant**，选模型、填入 DeepSeek API Key、勾选启用并保存。之后在源码编辑器中停顿即可看到补全建议；选中文字后使用工具栏的“AI 修改”按钮。

### 迁移和备份

迁移时需要同时保留/备份：

- 本仓库的 `overleaf-ai/` 和 `deploy/local/`。
- Overleaf Toolkit 的 `config/overleaf.rc`、`config/version`、`config/variables.env`。
- Overleaf Toolkit 的 `data/` 目录（尤其是 MongoDB 和 Overleaf 项目文件）。

`OVERLEAF_AI_SETTINGS_SECRET` 必须和 MongoDB 一起备份；丢失后将无法解密数据库里已保存的 DeepSeek API Key。不要把 `config/variables.env` 或 API Key 提交到 Git。迁移到兼容的 Overleaf 6.3.1 Toolkit 后，在新主机上从本仓库执行构建命令并运行 Toolkit 的 `bin/up -d`。

构建脚本会在 `config/overleaf.rc.bak-ai-*` 留下原设置副本。要回滚镜像，恢复该文件到 `config/overleaf.rc`，再执行 Toolkit 的 `bin/up -d`；原有项目数据不会因为切换回基础镜像而删除。

此 AI 集成针对固定的 Overleaf 6.3.1 源码版本。升级 Overleaf 前需要重新对照上游编辑器和管理页代码并重建；不要直接把此补丁套到其他版本。

### IP 证书

若现有 IP 证书不受信任或不包含 IP SAN，可以使用 Let’s Encrypt 的 IP 地址证书。Certbot 5.4+ 支持申请；IP 证书有效期为 6 天，必须配置自动续期和续期后的 Nginx reload。[Let’s Encrypt IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

## 云服务器资源

FRP 和 Nginx 转发本身通常可运行在 2核2G 上；Overleaf 和论文编译仍在本机运行。但你提供的控制台摘要显示当前实例为 4核4GB，已用内存约 2.34GB，若还承载其他服务，不建议将这台实例降至 2GB。3Mbps 公网带宽会限制大文件上传、下载和同步速度。
