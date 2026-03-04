# 存档库存/角色修改器

一个基于 Vite + TypeScript + React 的离线网页工具。

默认会在启动后自动尝试读取项目目录 `data` 下的数据库文件：

- `data/Items.json`
- `data/Weapons.json`
- `data/Armors.json`
- `data/Actors.json`
- `data/Skills.json`

如果某个文件不存在或格式不对，对应项会跳过，你仍可使用页面上的手动加载按钮。

## 功能

- 解密 RPG 存档（`base64 -> zlib -> MessagePack`）
- 向存档 `party._items`、`party._weapons`、`party._armors` 添加条目
- 向存档 `party._actors.@a` 添加角色 ID
- 编辑 `actors._data.@a` 里每个角色的 `_hp`、`_mp`、`_tp`、`_level`
- 编辑 `actors._data.@a[*]._exp`（只编辑经验值，仅保留一条）
- 角色编辑区一次只编辑一位角色（先选中目标角色）
- 编辑角色技能：在 `actors._data.@a[*]._skills.@a` 添加/删除技能 ID
- 从 `Items.json`、`Weapons.json`、`Armors.json`、`Actors.json` 读取数据库并展示列表
- 从 `Skills.json` 读取技能 ID 与名称
- 支持按分类筛选：
  - 物品按 `itypeId`
  - 武器按 `etypeId`
  - 护甲按 `atypeId`
  - 技能按 `stypeId`
- 已有库存支持直接加减和清零
- 支持按当前筛选结果批量添加（物品/武器/护甲/角色/技能）
- 支持最近 30 步操作撤销（覆盖库存、角色、技能、经验等变更）
- 列表采用分批渲染与滚动增量加载，降低大数据量卡顿
- 支持名称模糊匹配高亮
- 解析存档已有库存/角色时：若某个 id 不在数据库中，会自动跳过并继续

## 运行

```bash
npm install
npm run dev
```

## 使用步骤

1. 加载一个 `.rpgsave`
2. 加载 `data_decoded_pycrypto/Items.json`
3. 加载 `data_decoded_pycrypto/Weapons.json`
4. 加载 `data_decoded_pycrypto/Armors.json`
5. 加载 `data_decoded_pycrypto/Actors.json`
6. 加载 `data_decoded_pycrypto/Skills.json`
7. 在列表中筛选并点击“添加”，或使用“批量添加筛选结果”
8. 在“角色编辑（actors._data.@a）”中修改 `_hp/_mp/_tp/_level`
9. 在角色编辑中直接修改 `_exp`（经验值）
10. 切到“技能”列表，可按 `stypeId` 筛选并将技能添加到“当前编辑角色”
11. 在角色技能区输入/选择技能ID并添加，或删除已有技能
12. （可选）在“当前存档”面板里直接加减或清零已有条目
13. （可选）在角色面板移除已有角色
14. 若误操作可点击“撤销最近操作”回退
15. 点击“生成存档输出”
16. 点击“下载存档”
