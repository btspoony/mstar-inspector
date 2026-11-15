---
category: Fixed
---

- **A declaration's catalog sizes now follow the provider id, not the base URL**: one provider can be documented under three different endpoints (a saved declaration, the catalog row, models.dev), and the old equality gate then left models the vendor table sizes with no context window and no output cap at all. A model's sizes are the model's, so the id alone resolves them now — a declaration on any endpoint, the vendor's or the operator's own, gets that row's numbers, and an id the catalog does not carry still gets nothing. The model dialog pre-fills under the same rule.
- **One behavior is given up**: a declaration on the operator's own endpoint that reuses a catalog id now inherits that row's sizes (it inherited nothing before) — a private deployment that needs its own numbers needs a provider id of its own.

<!-- CN -->
- **声明取用的目录尺寸现在只看 provider id，不再看 base URL**：同一个提供方可能被三条来源记成三个不同端点（保存的声明、目录行、models.dev），旧的相等性门禁于是让厂商表明明收录了尺寸的模型完全没有上下文窗口和输出上限。模型尺寸属于模型本身，因此改为仅按 id 取用——无论声明指向厂商端点还是自有端点，都拿到该行的数字；目录没有的 id 依旧什么都拿不到。模型对话框按同一规则预填。
- **有一项行为随之放弃**：在自有端点上复用目录 id 的声明，现在会继承该行的尺寸（此前不继承）——需要独立数字的自建部署应改用独立的 provider id。
