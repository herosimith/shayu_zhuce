# GuJumpgate iCloud API

这是从 `GuJumpgate` 拆出的 iCloud API 邮箱池版本。

## 加载扩展

在 Chrome 扩展管理页打开开发者模式，加载本目录：

```text
/Users/lyr/Desktop/GuJumpgateIcloudApi
```

## 邮箱池格式

侧栏选择 `iCloud API 邮箱池` 后，在邮箱池里按行导入：

```text
邮箱----验证码接口URL
```

示例：

```text
chortle_palmate.3c@icloud.com----http://icloudapi.xyz/show/AhobCgIfCgYMBBdfSERSIxsGGAQQHUMaHAhZExcDD0gQARwBSBoTCwNGDAoBEw==/chortle_palmate.3c@icloud.com
```

运行时会从邮箱池按轮次取邮箱。第 4 步和后续登录验证码会轮询对应 URL，接口返回 JSON、纯文本或 HTML 都会尝试解析 6 位验证码。
