# Agent Input 自动补全与文本替换

> **当前文档：** 实现位于 Happy App 自己的 `AgentInput`、`MultiTextInput` 和
> `components/autocomplete/`。旧 Openland、Quill、`URickInput` 与
> `MessageInputInner` 说明已移除。

## 组件

- `components/AgentInput.tsx`：组合输入框、建议列表和选择行为；
- `components/MultiTextInput.tsx` / `.web.tsx`：React Native 与 Web 文本输入；
- `components/autocomplete/findActiveWord.ts`：识别 cursor 所在 active word；
- `components/autocomplete/useActiveWord.ts`：跟踪文本/selection 并触发查询；
- `components/autocomplete/useActiveSuggestions.ts`：加载建议；
- `components/autocomplete/applySuggestion.ts`：替换文本并返回新 cursor；
- `components/AgentInputAutocomplete.tsx`：渲染建议。

## Active word

`findActiveWord(content, selection, prefixes)` 默认识别 `@`、`:` 和 `/`：

- selection 必须是单一 cursor，选区存在时不触发；
- prefix 必须位于文本起点、空格或换行后的 word boundary；
- 返回完整 `word`、cursor 前的 `activeWord`、起点、长度和结束位置；
- `@` 被视为文件路径，可在 word 内包含 `/` 与 `.`；
- 换行、标点、括号和空格终止普通 active word；
- 单独输入 prefix 也返回结果，以便立即展示建议。

## 应用建议

`applySuggestion` 重新调用 `findActiveWord`，用选中的纯文本 suggestion 替换
`offset..endOffset`，按需要添加一个尾随空格，并返回：

```typescript
{
    text: string;
    cursorPosition: number;
}
```

没有 active word 时，suggestion 插入当前 selection。调用者随后更新
`MultiTextInput` 的文本与 cursor；Web 和 Native 共用相同字符串算法，不使用富文本 embed。

## AgentInput 数据流

1. `MultiTextInput` 报告文本和 selection；
2. `useActiveWord` 解析 active word；
3. `useActiveSuggestions` 用 prefix 与 query 获取候选；
4. `AgentInputAutocomplete` 显示键盘/触控可选列表；
5. 选择候选后 `applySuggestion` 生成文本和 cursor；
6. `AgentInput` 把新状态写回输入控件。

## 验证

- `findActiveWord.test.ts` 覆盖 prefix、boundary、文件路径、cursor 和 stop characters；
- `applySuggestion.test.ts` 覆盖替换范围、尾随空格与 cursor；
- 修改 Web/Native 输入事件时，同时验证键盘导航、IME/selection 和触控选择不改变共用算法。
