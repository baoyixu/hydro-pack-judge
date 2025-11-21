# hydro-pack-judge

本插件用于在 Hydro 中对压缩包形式提交的参赛代码进行批量评测。

## 安装

### 1. 克隆本仓库

```bash
git clone https://github.com/mywwzh/hydro-pack-judge.git
```
## 2. 安装依赖

在 `hydro-pack-judge` 插件目录下安装依赖：

```bash
cd <full-path-to-hydro-pack-judge>
yarn install
```

## 插件安装到 Hydro

1. 将插件目录添加到 Hydro：

```bash
hydrooj addon add /full/path/to/hydro-pack-judge
```

2. 重启 Hydro 服务：

```bash
pm2 restart hydrooj
```

## 上传包的目录结构要求

插件会解压上传的压缩包并尝试识别选手目录。要求的压缩包结构：

```
package.zip
└─ 包根目录/
   ├─ SC-J00001/    # 准考证号或用户名
   │  ├─ A/        # 题目目录（problemDirs 中列出的目录名）
   │  │  └─ A.cpp
   │  └─ B/
   └─ SC-J00002/
      └─ A/
```


## 使用

该插件在比赛页面注入“批量评测”入口，只有比赛所有者或有编辑比赛权限的用户可见。

1. 打开比赛页面，按正常比赛配置题目和数据。
2. 点击 “批量评测”。
3. 在界面上传压缩包，并填写每题的目录名。
4. 点击开始评测。

## 常见问题

- 插件无法找到题目文件：确认 `problemDirs` 名称与压缩包中目录名完全匹配（大小写敏感）。
- 插件未生效或按钮未出现：确认你是比赛所有者或具有 `PERM_EDIT_CONTEST` 权限。

## 贡献

欢迎通过 Issue 或 Pull Request 提交改进。请在 PR 中说明兼容性、测试方法与变更目的。
