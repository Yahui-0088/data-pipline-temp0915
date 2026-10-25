# 内网共享

默认服务只听 `127.0.0.1`，同事要开 SSH 隧道才能打开。对内网开放后，同事在内网（或同一个 tailscale 网络）里直接打开
`http://<服务器 IP>:<端口>` 就能用，不需要隧道。

## 开启

1. 打开登录（对内网开放时必须开；关着登录会拒绝启动）。在部署目录的 `.env` 里：

       EMQC_AUTH_DISABLED=0
       EMQC_AUTH_OPEN=0            # 0 = 校验密码；1 = 试用模式，填名字就进（会有警告）
       EMQC_API_HOST=0.0.0.0       # 或者启动时加 --lan

2. 给每个人建账号（初始密码只显示一次，首次登录必须修改）：

       .venv/bin/python -m emqc create-user --username zhangsan --display 张三 --role reviewer

   角色：`admin` 管理员、`reviewer` 审核员（能跑 QC、导出、生成训练数据包）、`annotator` 标注员。

3. 重启：

       .venv/bin/python -u scripts/serve.py 8793 --lan

   启动日志里会打印「内网访问地址」，流水线页「概览 → 访问」也会显示。

4. 防火墙（如果开了）：`sudo ufw allow 8793/tcp`，或者只放行内网段：`sudo ufw allow from 10.0.0.0/8 to any port 8793`。

## 安全

- 对内网开放 + 关掉登录（`EMQC_AUTH_DISABLED=1`）默认拒绝启动；确实要这样设 `EMQC_ALLOW_LAN_WITHOUT_LOGIN=1`。
- 写接口只接受本站页面发来的请求（Origin 校验），换了访问地址也照常生效。
- 训练 / 推理脚本用服务令牌访问：`.env` 里设 `EMQC_API_TOKEN=<随机串>`，请求头带 `X-EMQC-Token`。
- 走 https 反向代理时设 `EMQC_COOKIE_SECURE=1`。

## 汇报账号（给老板 / 合作方看，按项目隔离）

汇报账号登录后**只能打开汇报页 `/report`**，其他页面一律跳回汇报页，其他接口（数据、预览图、下载、跑任务）一律 403。
它只能看分配给它的项目（数据集的 `project` 字段）；汇报页里的数字、明细和问题样例图都只来自这些项目，
样例图会先核对所属项目，别的项目的图当作不存在（404）。

    .venv/bin/python -m emqc create-user --username boss --display 老板 --role reporter --projects du1,h01

也可以在「用户管理」页新建（角色选「汇报」并填项目），或给已有汇报账号点「改项目」。
汇报页右上角「导出 PDF」= 浏览器打印，深色模式下也按浅色打印。其他角色在左侧导航点「汇报」能看全部项目。
