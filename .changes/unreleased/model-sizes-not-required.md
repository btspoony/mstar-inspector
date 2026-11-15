---
category: Fixed
---

- **A model with no catalog size and no typed size now saves**: the model dialog used to refuse the save when neither the model catalog nor the form supplied a context window or a max token count, so a declaration on your own endpoint — which never borrows the vendor's numbers — could not be saved for a model the catalog does not size. The save now lands: the model is stored as unstated and the runtime's own default applies. A catalog size is still pre-filled and labelled with its snapshot, and a stated size must still be a positive whole number, so a typo is still named instead of stored.

<!-- CN -->
- **既无目录尺寸也无需手填尺寸的模型现在可以保存**：当模型目录和表单都没有给出上下文窗口或最大 token 数时，模型对话框此前会拒绝保存；指向自有端点的声明本就不会借用厂商数字，因此目录未收录尺寸的模型无从保存。现在保存会成功：该模型按未声明存储，运行时使用自身默认值。目录有值仍然预填并标注来源快照，已填写的尺寸仍必须是正整数，因此输错依然会被指出而不是被存下。
