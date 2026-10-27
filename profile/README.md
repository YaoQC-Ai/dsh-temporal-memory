# L4 — User and Agent profile

L4 is neither a retrieval index nor an alias for L3 concept pages. The search
index is a derived facility and consumes no layer number.

Runtime location: `$DSH_HOME/memory/temporal/profile/`.
`memory_health.layers.L4` reports the real state:
`disabled` / `pending` / `active` / `human_edited`.

## Layout

```text
profile/
  user/
    profile.md            # explicit user preferences, quoted verbatim
  agent/
    personality.md        # soft profile: tone, initiative, reminder style, limits
    history/              # monthly snapshots and diffs; safe to roll back
      2026-10.md
      2026-10.diff
  evidence/
    2026-10.jsonl         # count/reference evidence for the profile; no raw text
  _index.md               # current version plus history index
  _state.json             # machine state: month, hash, last run; do not edit by hand
```

`personality_hash` in `_state.json` is how the plugin detects that a human has
edited `personality.md`.

## Monthly growth

- Requires `growth.enabled=true`. It is off by default and can be switched on in
  Settings → Memory.
- No timer is kept alive. Each `agent/created` checks once; the target month is
  the **previous** month, and `_state.json` records it so a month is generated
  at most once.
- Input: previous-month L1 counts and topics, L2 journal entries, and the L3
  page count. **It does not read raw transcripts and does not call a model** —
  the summary is rule-based.
- Output: a new `agent/personality.md`, a snapshot and diff under `history/`,
  `evidence/YYYY-MM.jsonl`, an updated `_index.md`, and a `growth` audit event.
- Effect: the profile body is injected once per session (including after
  compaction) in `agent/pre-step`. `memory_health.growth.applied` and
  `personality_version` show whether it actually reached the model.
- Boundaries: only soft traits are adjusted. System role, safety policy,
  permissions, memory write rules, and user profile facts are never changed.
- Fewer than `MIN_RECORDS` (5) L1 records in the month → the profile is left
  unchanged and `last_run` records `insufficient_evidence`.
- With the switch off, L4 is neither updated nor injected.

## Human takeover

Edit `agent/personality.md` directly. On the next monthly run the content hash
will not match `_state.json`, so the plugin treats the file as human-owned:

- it does not overwrite the file or write a new history snapshot;
- `_state.json` becomes `human_edited`, and `memory_health.layers.L4.status`
  reports `human_edited`;
- to resume automatic maintenance, remove `personality_hash` from
  `_state.json`, or delete `_state.json`.

Deleting the profile only makes the next monthly run summarize again; profile
content is never written back into L1 as fact.

## Rollback

Each month is snapshotted in `agent/history/YYYY-MM.md`. After reviewing it,
copy its content over `personality.md`. That copy also counts as a human edit,
so automatic maintenance stops — which is the intended behavior.

---

# 中文说明

L4 是用户与 Agent 画像，不是检索索引，也不是 L3 概念页的别名；索引是派生设施，不占层号。运行时目录为 `$DSH_HOME/memory/temporal/profile/`，`memory_health.layers.L4` 反映真实状态（`disabled` / `pending` / `active` / `human_edited`）。

## 目录

- `user/profile.md`：用户明确说过的偏好原文，不改写、不推测。
- `agent/personality.md`：Agent 软画像（表达风格、主动性、提醒方式、能力边界、关注面）。
- `agent/history/`：每月快照与 diff，可回滚。
- `evidence/YYYY-MM.jsonl`：画像的证据引用（只有计数与引用，不含原文）。
- `_index.md`：当前版本与历史索引；`_state.json`：机器状态，不要手改。

## 月度成长

- 需要 `growth.enabled=true`，默认关闭，可在设置页开启。
- 不引入常驻定时器；每次 `agent/created` 检查一次，目标是上个月，`_state.json` 记录月份，同月最多生成一次。
- 输入是上月 L1 的计数与主题、L2 日记条目、L3 页数；**不读原始会话全文，不调模型**。
- 输出新版本 `personality.md`、`history/` 快照与 diff、`evidence/`、`_index.md`，并写审计 `growth` 事件。
- 每个会话（含压缩后）在 `agent/pre-step` 注入一次画像正文；`memory_health.growth.applied` 可验证是否真的接上。
- 边界：只调整软画像，不修改系统角色、安全策略、权限、记忆写入规则，也不改写用户画像事实。
- 上月 L1 少于 5 条时保持原状；关闭开关后既不更新也不注入。

## 人工接管与回滚

直接编辑 `agent/personality.md`，下次月度任务发现哈希不一致就停止自动覆盖，并标记 `human_edited`。想恢复自动维护，删除 `_state.json` 中的 `personality_hash`（或删除整个文件）。每月快照在 `agent/history/YYYY-MM.md`，确认后可覆盖回 `personality.md`；覆盖同样会被视为人工编辑，自动维护随之停止。
