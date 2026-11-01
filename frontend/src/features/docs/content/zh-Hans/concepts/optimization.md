Skynet 就是 Optimize Anything：一个基于你的数据和指标改进任意产物的产品。每次运行都使用同一个运行契约和同一个指标契约。产物类型决定了哪些引擎可以处理它。

## 共享契约

每次运行都有两个文件。`run.py` 在一个用例上运行产物。`metric.py` 为输出打分。

```python tab="run.py"
from skynet import llm


def run(artifact, input):
    return llm(artifact, input=input)
```

```python tab="metric.py"
def score(input, output, expected=None):
    ok = output == expected
    return (1.0 if ok else 0.0), {"feedback": "Match." if ok else "No match."}
```

- `artifact` 是优化器提出的当前版本。
- `input` 是一个 dict，包含一个用例的输入字段。
- `expected` 是该用例的期望值；如果用例没有期望值，则为 `None`。
- `score` 返回一对值：一个数字，以及一个包含 `"feedback"` 字符串的 dict。

`skynet` 辅助模块提供 `llm`、`Image` 和 `log`。在运行代码中调用 `llm` 会使用任务模型。在指标中调用 `llm` 会使用指标模型。

> [!NOTE]
> 运行代码在沙箱中自己的进程里运行。它看不到指标源代码、期望值或指标密钥。

完整的指标契约请阅读[指标与评分器](/docs/concepts/scorers)。

## 产物类型与引擎

| 产物类型  | 引擎                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| 提示词    | Auto、GEPA、Best-of-N、AutoResearch、Meta-Harness、AutoSaddler、ShinkaEvolve |
| 代码      | 与提示词相同                                                                 |
| 文本      | 与提示词相同                                                                 |
| DSPy 程序 | Auto、DSPy GEPA、DSPy MIPROv2、DSPy BootstrapFewShot                         |

引擎分为两个系列：

- **原生引擎** 把产物当作黑盒。它们处理提示词、代码和文本产物。
- **DSPy 优化器** 在 DSPy 程序内部工作。它们只处理 DSPy 程序产物。

DSPy MIPROv2 和 DSPy BootstrapFewShot 需要成对数据（带期望输出的用例）。如果只有单个输入，DSPy 程序只能使用 Auto 和 DSPy GEPA。

## 提示词、代码和文本产物

原生引擎把产物当作黑盒。引擎提出一个新版本，在用例上运行 `run(artifact, input)`，然后读取分数和反馈。

六个原生引擎使用不同的搜索方法：

- **GEPA** 通过反思来演化版本，并维护一个 Pareto 前沿。
- **Best-of-N** 让反思模型给出相互独立的提议，并保留最好的一个。
- **AutoResearch**、**Meta-Harness**、**AutoSaddler** 和 **ShinkaEvolve** 使用编程智能体来提出版本。

每个引擎及其设置请阅读[引擎](/docs/concepts/engines)。

## DSPy 程序产物

DSPy 程序是一种产物类型。你的 `run.py` 在模块级构建一个 `dspy.Module`，并在 `run` 中调用它。如果文件中有多个模块，请把要优化的那个命名为 `program`。

DSPy 优化器运行时会发生以下过程：

1. Skynet 找到你的模块，并用你的 `run` 函数包装它。每个用例都会经过你自己的 `run`。
2. DSPy 优化器在训练用例上编译程序。
3. 它在验证用例上进行选择。
4. 胜出者是每个预测器的指令文本，加上模块完整的编译状态。该状态包含 few-shot 示例。

最终分数衡量的正是 Skynet 保存的那个程序。

| 优化器                | 是否读取反馈文本 |
| --------------------- | ---------------- |
| DSPy GEPA             | 是               |
| DSPy MIPROv2          | 否，只读分数     |
| DSPy BootstrapFewShot | 否，只读分数     |

DSPy BootstrapFewShot 不使用反思模型。

> [!TIP]
> DSPy 反思模型只能看到你的指标返回的反馈文本。它永远看不到指标源代码。

## Auto

**Auto** 是向导中的默认选项。

- 对于提示词、代码或文本产物，Auto 先用五个原生引擎进行探索，然后从最佳版本出发用 GEPA 继续优化。
- 对于 DSPy 程序，Auto 运行 DSPy GEPA。

两种形式的 Auto 都会读取你的指标给出的反馈文本。

## 该选哪个引擎

| 你的情况                                     | 使用                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| 你有一个由模型运行的提示词                   | 提示词产物。从 Auto 开始。                                  |
| 你有想要更快、更便宜或更正确的代码           | 代码产物。从 Auto 开始。                                    |
| 你有一份文档或一份配置                       | 文本产物。从 Auto 开始。                                    |
| 你有一个 DSPy 程序                           | DSPy 程序产物。从 Auto 开始。                               |
| 你希望从数据中挑选 few-shot 示例             | 使用 DSPy BootstrapFewShot 或 DSPy MIPROv2 的 DSPy 程序产物 |

> [!WARNING]
> GEPA、DSPy GEPA 和 Auto 会从反馈文本中学习。如果你的反馈总是同一个字符串，这些优化器能利用的信息就更少。

## 相关页面

- [引擎](/docs/concepts/engines)
- [数据集与划分](/docs/concepts/datasets)
- [指标与评分器](/docs/concepts/scorers)
- [提交运行](/docs/guides/submit)
