# Zotero Smart Highlighter 非 LLM 高亮排序系统调参计划

## 1. 概述

本文档是 Zotero Smart Highlighter 非 LLM 高亮排序系统的调参计划。排序系统的核心任务是：在不依赖大语言模型的前提下，从 PDF 论文中自动筛选出最值得高亮的句子，并按相关性排序。

**目标：** 通过系统化的参数调整，提升高亮候选的排序质量，减少"假阳性"（不值得高亮的句子排名过高）和"假阴性"（有价值的句子被遗漏）。

**适用范围：**

- Phase 1（启发式 + 词法混合评分）的所有可调参数
- Phase 2（作者关键词提取 + score breakdown 调试日志）引入的新参数
- Phase 3（Neural Reranker）上线后的权重重新校准

**源代码参考：** `src/reading-highlights.ts`

---

## 2. 可调参数清单

### 2.1 分数融合权重

排序系统将 heuristic score（启发式评分）和 lexical score（词法评分）线性融合为 final score。两种模式使用不同的融合系数：

| 模式 | heuristic 权重 | lexical 权重 | reason-section bonus | 代码位置 |
|------|---------------|-------------|---------------------|---------|
| Selection（选区模式） | 0.72 | 0.28 | 不参与 | L377 |
| Global（全文模式） | 0.68 | 0.32 | 叠加 | L435 |

**Phase 3 预留（带 Neural Reranker）：**

| 模式 | heuristic | lexical | neural |
|------|-----------|---------|--------|
| Global | 0.35 | 0.15 | 0.50 |
| Selection | 0.40 | 0.10 | 0.50 |

**调整方向：**

- 如果某类论文 heuristic 过度主导（例如 methods 术语密集的论文），降低 heuristic 权重、提升 lexical 权重
- 如果 lexical score 噪声大（pseudo-query 质量差），提升 heuristic 权重
- Global 模式的 lexical 权重已略高于 Selection 模式，因为 global 模式有更大的候选池供 BM25 区分

### 2.2 分数阈值

final score 低于阈值的候选将被过滤掉：

| 模式 | 阈值 | 代码位置 |
|------|------|---------|
| Selection | 0.22 | L385 |
| Global | 0.20 | L444 |

**调整方向：**

- 提高阈值 = 更严格过滤（输出更少更精准的候选）
- 降低阈值 = 更多候选（召回率提升，但精度可能下降）
- Selection 模式阈值略高，因为选区场景用户期望更精确的结果

### 2.3 启发式评分参数

启发式评分由 `scoreCandidate` 函数计算，基于 section 权重、正向/负向 regex 模式匹配、以及多项附加惩罚/加分。

#### 2.3.1 POSITIVE_PATTERNS（正向模式，8 组）

| 模式 | 权重 | 匹配目标 |
|------|------|---------|
| `we (propose\|present\|introduce\|show\|find\|demonstrate\|observe\|report)` | +4 | 作者核心声明 |
| `outperform\|improv(e\|es\|ed)\|better than\|state-of-the-art\|sota\|significant(ly)?` | +4 | 性能比较、显著性 |
| `result\|results\|finding\|findings\|evidence\|achiev(e\|es\|ed)\|yield(s\|ed)?` | +3 | 实验结果 |
| `limit(ation\|ations)?\|caveat\|however\|fails?\|failure\|underperform\|...` | +3 | 局限性、注意事项 |
| `problem\|challenge\|gap\|remains\|unclear\|little is known\|motivat(e\|es\|ion)` | +2 | 研究动机 |
| `method\|architecture\|training\|dataset\|evaluation\|ablat(ion\|e)\|...` | +2 | 方法描述 |
| `precision\|recall\|f1\|accuracy\|auc\|bleu\|rouge\|percent\|%` | +2 | 量化指标 |
| `novel\|contribution\|contributions\|first to\|we argue\|we claim\|our work` | +2 | 创新声明 |

#### 2.3.2 NEGATIVE_PATTERNS（负向模式，7 组）

| 模式 | 惩罚 | 匹配目标 |
|------|------|---------|
| `Fig.\?\|Figure\|Table\|Eq.\?\|Equation\|Appendix` | -5 | 图表/公式引用 |
| `et al.` | -2 | 引用标记 |
| `this\|these\|it\|they\|such` | -1 | 模糊代词 |
| `related work\|in this section\|the rest of the paper\|as shown in` | -4 | 过渡性/样板句 |
| `[数字列表]`（方括号引用） | -2 | 数字引用标记 |
| `(作者 年份)` 格式 | -2 | 括号引用标记 |
| `doi\|https?://` | -4 | URL/DOI |

#### 2.3.3 附加惩罚与加分

| 条件 | 分数变动 | 说明 |
|------|---------|------|
| `sectionKind === 'references'` 或 reference-like text | -12 | 参考文献段落强惩罚 |
| 词数 > 30 | -3 | 过长句子惩罚 |
| 词数 > 22 | -1 | 中长句子轻微惩罚 |
| 以 `we`/`our` 开头 | +1 | 作者叙述加分 |
| 包含数值证据（数字+单位） | +1 | 量化表述加分 |
| 无字母或数字字符 | -3 | 非文本内容惩罚 |
| 引用标记 >= 2 个 | -3 | 引用密集惩罚 |
| 模糊代词 >= 2 个 | -2 | 代词过多惩罚 |

### 2.4 FOCUS_SECTION_WEIGHTS

4 种 focus mode 下各 section kind 的基础权重（作为 heuristic score 的起始值）：

| Section Kind | balanced | results-first | methods-first | caveats-first |
|-------------|----------|---------------|---------------|---------------|
| abstract | 4 | 3 | 4 | 3 |
| introduction | 3 | 2 | 3 | 3 |
| related-work | 1 | 1 | 1 | 1 |
| methods | 2 | 1 | **5** | 1 |
| results | **5** | **6** | 3 | 3 |
| discussion | 4 | 5 | 2 | **6** |
| conclusion | 3 | 3 | 2 | 5 |
| references | -8 | -8 | -8 | -8 |
| other | 2 | 2 | 2 | 2 |

**调整方向：**

- 如果某个 focus mode 下不期望的 section 候选过多，降低该 section 的权重
- references 的 -8 加上 `scoreCandidate` 中的 -12，实际惩罚为 -20，几乎不可能出现在最终结果中

### 2.5 密度配置（DENSITY_CONFIGS）

3 种 density level 控制输出量和候选范围：

#### Quick 模式参数

| 参数 | sparse | balanced | dense |
|------|--------|----------|-------|
| quickMinChars | 16 | 16 | 14 |
| quickMaxChars | 140 | 160 | 180 |
| quickMaxWords | 24 | 28 | 32 |
| quickMaxHighlights | 2 | 3 | 5 |

#### Global 模式参数

| 参数 | sparse | balanced | dense |
|------|--------|----------|-------|
| globalMinChars | 20 | 18 | 16 |
| globalMaxChars | 220 | 240 | 260 |
| globalMaxWords | 36 | 40 | 44 |
| globalShortlistSize | 60 | 100 | 150 |
| globalMaxHighlights | `min(50, max(10, pages*3))` | `min(100, max(20, pages*6))` | `min(150, max(30, pages*10))` |
| globalMaxPerPage | 5 | 10 | 15 |
| shortlistPerPageCap | 6 | 12 | 18 |

### 2.6 词法排序参数

#### 2.6.1 BM25 参数

| 参数 | 当前值 | 经典默认值 | 说明 |
|------|--------|-----------|------|
| k1 | 1.2 | 1.2 | 词频饱和度；增大使高频词获得更多收益 |
| b | 0.75 | 0.75 | 文档长度归一化；增大惩罚长文档 |

当前值为经典 BM25 默认值，一般无需调整。如果短句因长度归一化获得不合理优势，可适当降低 b 值。

#### 2.6.2 TF-IDF 归一化

使用 max-normalization：`score / max(scores)`，将所有分数映射到 [0, 1]。此方式简单但对极端值敏感。

#### 2.6.3 Pseudo-query 构建

`buildGlobalPseudoQuery` 的 keyword pool 由以下来源按优先级组成：

1. **作者关键词**（Phase 2.1）：最多取前 10 个，最高优先级
2. **论文标题**
3. **章节标题**：最多前 12 个（排除 references）
4. **Abstract/Introduction 高分候选**：按 heuristic score 排序取前 6 条
5. **Top terms**：从全部候选文本中提取频率最高的 24 个 token

**调整方向：**

- 增加作者关键词上限（从 10 提升）可增强主题聚焦
- 减少 top terms 数量可降低噪声
- 调整 abstract snippets 数量影响 query 对论文核心观点的覆盖

### 2.7 Reason-Section 对齐加分

`getReasonSectionAlignmentBonus` 为 reason 与 section 的语义对齐提供额外加分（仅 Global 模式）：

| reason | 对齐 section | bonus |
|--------|-------------|-------|
| result | results, abstract | +0.06 |
| method | methods | +0.06 |
| caveat | discussion, conclusion | +0.05 |
| claim | abstract, introduction, conclusion | +0.04 |
| background | introduction | +0.03 |

**调整方向：**

- 这些 bonus 值相对 [0, 1] 范围的 final score 而言较小（3%~6%），是微调手段
- 如果某类 reason 的候选在"正确" section 中仍排名偏低，可适当提高对应 bonus

---

## 3. 调参方法论

### 3.1 基准测试集

选择 5-10 篇涵盖不同类型的论文作为固定基准，确保调参结果具有代表性：

| 类型 | 数量 | 选择标准 |
|------|------|---------|
| 实验性论文 | 2 篇 | 结果密集，含大量数值和图表引用 |
| 综述论文 | 2 篇 | 方法比较多，跨领域引用密集 |
| 方法论文 | 2 篇 | 算法描述多，methods 章节占比大 |
| 临床/社会科学论文 | 2 篇 | 非 STEM 风格，术语体系不同 |
| 中文论文 | 1-2 篇 | 测试多语言分词和模式匹配 |

每篇论文应转为 PDF 并在 Zotero 中导入，确保测试环境与真实使用场景一致。

### 3.2 评估指标

对每篇基准论文，人工标注"应该高亮"的句子，然后与系统输出比较：

- **Precision@k**：系统输出的 top-k 候选中，有多少是人工标注的"应该高亮"句子
- **Recall@k**：人工标注的全部"应该高亮"句子中，有多少出现在系统的 top-k 输出中
- **主观质量评分**：1-5 分，评估高亮结果的整体阅读体验

标注建议：

- 每篇论文标注 10-20 个"值得高亮"的句子
- 标注时不看系统输出，避免偏见
- 比较不同参数设置下的 top-10 和 top-20 命中率

### 3.3 调参流程

1. 启用 Phase 2.2 的 score breakdown 日志（`Zotero.debug` 输出每个候选的分项得分）
2. 在每篇基准论文上运行 Global 模式
3. 从日志中提取 score breakdown，分析 heuristic score、lexical score、reason bonus 的贡献
4. 识别错误排名的候选，按错误类型分类：
   - **漏选（False Negative）：** 有价值的句子未进入 top-k
   - **错选（False Positive）：** 低价值的句子排名过高
5. 针对错误类型定位对应参数，制定调整方案
6. 修改参数后重新运行，在全部基准论文上验证改善效果
7. 确认无回退后提交参数变更

### 3.4 分层调参策略

按参数的影响范围从大到小，分四轮进行调参：

| 轮次 | 调整对象 | 杠杆效应 | 风险 |
|------|---------|---------|------|
| 第一轮 | 融合权重（heuristic/lexical 比例） | 最大 | 全局影响，需全面回归 |
| 第二轮 | 分数阈值（Selection/Global 阈值） | 中等 | 影响输出数量，较易观察 |
| 第三轮 | 正向/负向模式权重（POSITIVE/NEGATIVE_PATTERNS） | 细粒度 | 仅影响特定模式匹配 |
| 第四轮 | 密度配置与 per-section budget | 细粒度 | 影响候选池大小和分布 |

每轮调参完成后，在全部基准论文上回归验证，确认 Precision@10 和 Recall@20 无回退。

---

## 4. 已知问题与调参方向

### 4.1 Methods 章节过度偏好

**现象：** BM25 对 methods 章节中反复出现的技术术语敏感，导致 methods 候选的 lexical score 偏高，在 Global 模式下排名过度靠前。

**根因分析：** methods 章节通常术语密度高、重复率高，BM25 的词频 (TF) 分量天然偏向这类文本。

**调参方向：**

- 降低 `methods-first` 以外 focus mode 中 methods 的 section weight（当前 balanced 模式下为 2）
- 在 Global 模式中增加一项 methods section 的 lexical score 衰减系数
- 或者在 pseudo-query 构建时，降低 methods 章节 heading 的贡献权重

### 4.2 PDF 分句质量

**现象：** 双栏排版的 PDF 在跨列处、脚注处容易产生断裂的句子，这些低质量候选可能获得不合理的分数。

**调参方向：**

- 提高 `globalMinChars` / `quickMinChars` 阈值，过滤过短的碎片
- 在 NEGATIVE_PATTERNS 中增加常见脚注模式（如页码格式、期刊缩写）
- 增加对非完整句子的检测（例如缺少句号结尾的短文本）

### 4.3 Pseudo-query 质量

**现象：** 当论文没有作者关键词（keywords 字段为空）时，pseudo-query 主要依赖标题 + 章节标题 + top terms 构建，可能偏离论文核心主题。

**已有改善：** Phase 2.1 的作者关键词提取功能已从 PDF 文本中自动提取 keywords，显著提升了 pseudo-query 质量。

**进一步调参方向：**

- 增加作者关键词在 keyword pool 中的上限（当前为 10）
- 对 abstract snippets 的数量做实验（当前为 6 条），确认是否需要更多
- 在无作者关键词 fallback 时，提升 abstract snippets 的比例

### 4.4 短句偏好

**现象：** 过短的句子（< 8 词）可能因 heuristic 模式匹配密度高而获得不合理的高分。例如 "Results are significant." 虽然命中多个正向模式，但信息量极低。

**调参方向：**

- 增加词数惩罚的梯度：当前仅在 > 22 词和 > 30 词时惩罚，可增加 < 8 词的惩罚
- 或者对 heuristic score 按词数做归一化（除以 `log(wordCount)`）
- 注意不要同时惩罚短句和长句导致中等长度过度偏好

---

## 5. 调参记录模板

为每次调参实验创建如下格式的记录，保存在 `.local-docs/tuning-logs/` 目录下：

```markdown
### 实验 [编号] - [日期]

- **修改参数：**
  - `[参数名]`: [旧值] -> [新值]
  - `[参数名]`: [旧值] -> [新值]
- **修改理由：** [简述为什么调整这些参数]
- **测试论文：** [列出测试的论文标题/DOI]
- **结果：**

| 论文 | Precision@10 | Recall@20 | 主观评分 (1-5) |
|------|-------------|-----------|---------------|
| 论文 A | 0.xx | 0.xx | x |
| 论文 B | 0.xx | 0.xx | x |
| 平均 | 0.xx | 0.xx | x |

- **观察：**
  - [记录排名变化的具体案例，例如"论文 A 中 methods 候选从 #3 降至 #8"]
  - [记录意外的回退现象]
- **对比基线：**
  - Precision@10 变化: [+x% / -x%]
  - Recall@20 变化: [+x% / -x%]
- **结论：** [保留 / 回退 / 继续调整]
```

---

## 6. 时间线

| 阶段 | 时间节点 | 任务 |
|------|---------|------|
| Phase 2 完成后 | 首次调参窗口 | 建立基准测试集；完成第一轮融合权重调参；记录 baseline 指标 |
| Phase 2 稳定后 | 持续改进 | 完成第二轮（阈值）和第三轮（模式权重）调参 |
| Phase 3 完成后 | 重新校准 | Neural reranker score 加入后，重新校准全部融合权重 |
| 持续 | 每次重大参数变更后 | 在基准测试集上回归验证，记录调参日志 |

**原则：** 每次只调整一个维度的参数，控制变量。每次变更必须在基准测试集上回归验证，不允许仅凭单篇论文的表现决定参数。
