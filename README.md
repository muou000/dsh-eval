# dsh-eval

`dsh-eval` 是 DeepSeek Harness（DSH）的证据优先评测插件。它在彼此隔离的工作区内成对运行受信任的本地 baseline 与 candidate，用评测器控制的文件、JSON 和可信脚本检查外部世界状态，再生成带输入哈希、逐次观察和预注册门槛的 JSON/Markdown 报告。

当前版本是 development candidate。仓库内 keyless 校准套件故意比较一个已知错误实现和一个已知正确实现；它能证明评测器检测到预期差异，不能证明任何真实 DSH 插件或模型已经提升。真实模型与生产晋级仍需单独运行。

当前兼容目标为 DSH `0.1.1-rc.2` 与 `0.1.2-alpha.1` 的公开 session 事件契约。可用 `pnpm run eval:current-dsh -- --dsh-root <clean-checkout>` 对相邻的干净 DSH 构建执行服务、probe 与卸载冒烟；该结果仍只是自报遥测兼容性证据。

## 能力边界

- 版本化 `manifest`、case、report 和 probe 契约，未知字段失败关闭。
- baseline/candidate 按 case 和 repetition 配对；固定 seed 决定首个顺序，随后严格 AB/BA 交替，同一 pair 不并发。
- 每次运行使用独立 workspace、home、临时目录和环境；父进程环境默认只传递系统启动所需字段。
- fixture、trusted scorer 和 variant artifact 全部 SHA-256 内容寻址；每次观测只执行该 variant 的私有 artifact 快照，入口 artifact 必须与实际 argv/executable 绑定。
- 内置退出码、文件存在/缺失、文件内容、JSON Pointer 和可信 Node.js 脚本评分器。
- 记录超时、取消、退出码、信号、启动错误、完整输出字节数/哈希和工作区 diff；默认不保存输出正文。
- 报告 success/score/latency 分布、Wilson 95% 区间、逐对改进/退化和质量/安全/隐私/稳定性门槛。
- profile 加载本插件时，probe 从 DSH `session/event` 记录 turn、model call、tool error 和 durable usage；这些数据由被测进程写入，只是自报观测，不能通过 token/cost 晋级门槛。
- Cordis `ctx.evals` 服务、独立 `dsh-eval` CLI、Loader 组合/热卸载，以及 timeout、取消和 CLI 信号清理。

## 安装与检查

```powershell
pnpm install
pnpm run check
pnpm run test:integration
pnpm run eval:keyless
pnpm run eval:pack
```

作为 DSH bundle 安装时，包内 `cordis.patch.yml` 会插入 `dsh-eval`。插件提供 `ctx.evals.run(manifest, options)`；命令行不需要先启动 DSH：

```powershell
dsh-eval validate .\evals\manifest.json
dsh-eval run .\evals\manifest.json --output .\evals\reports\latest.json --require-pass
```

`--require-pass` 在本地预注册门槛为 `fail` 或 `not-configured` 时返回退出码 2。`decision: pass` 仍不是自动晋级证明：本地报告固定写入 `assurance: local-trusted-process`、`promotionEligible: false` 和阻断原因。

一旦提供 `thresholds`，validator 会要求恰好选择 `test` split、至少 5 次重复、两侧 runtime/entry artifact，以及成功率、平均分增益、逐对/任务回归、均值/p95 延迟和 safety/privacy/stability 全部门槛；模型比较还必须预注册 token 与成本门槛。缺字段不是“跳过”，而是 manifest 无效。

当前开发/验证矩阵为 Node.js `^22.19.0 || >=24.0.0`、pnpm `10.33.0`、Cordis `^4.0.1` 及 npm 已发布的 DSH session 契约 `^0.1.1-rc.2`。在相邻 DSH `0.1.2-alpha.1` revision `cd5ef814...` 上，打包插件已分别通过源码 CLI 和构建后公开 SDK 的真实进程组合验证：两者都安装到独立命名 profile，并在本地 mock OpenAI-compatible 上游下完成一个 turn。该证据只覆盖安装、加载和入口兼容性，不等同于真实模型效果或生产晋级证明。

当前包尚未发布到 npm。源码安装先运行 `pnpm install && pnpm pack`，再让目标 DSH bundle 固定生成的 `.tgz`，不要依赖浮动 Git HEAD。卸载时从 profile 移除 `dsh-eval`，确认没有运行中的 evaluator 后清理 `<DSH_HOME>/eval/v1/runs`；报告目录单独按保留策略处理。回滚就是重新固定上一个已验证 tarball，旧报告不得改写，详细步骤见 [运维说明](docs/OPERATIONS.md)。

## 最小 manifest

```json
{
  "schema": "dsh-eval-manifest",
  "schemaVersion": 1,
  "id": "plugin-comparison",
  "dataset": {
    "id": "frozen-cases",
    "version": "2026-08-30",
    "caseFiles": ["cases/case-001.json"]
  },
  "variants": {
    "baseline": {
      "id": "stable",
      "revision": "git:abc123",
      "executable": "node",
      "args": ["{manifestDir}/runners/stable.mjs"],
      "artifacts": ["runners/stable.mjs", "artifacts/stable.tgz"],
      "entryArtifact": "runners/stable.mjs",
      "runtime": {
        "harnessVersion": "0.1.2-alpha.1",
        "profile": "headless",
        "provider": "openai",
        "model": "pinned-model-id",
        "sampling": { "temperature": 0, "topP": 1, "seed": 7, "maxOutputTokens": 4096 }
      }
    },
    "candidate": {
      "id": "candidate",
      "revision": "git:def456",
      "executable": "node",
      "args": ["{manifestDir}/runners/candidate.mjs"],
      "artifacts": ["runners/candidate.mjs", "artifacts/candidate.tgz"],
      "entryArtifact": "runners/candidate.mjs",
      "runtime": {
        "harnessVersion": "0.1.2-alpha.1",
        "profile": "headless",
        "provider": "openai",
        "model": "pinned-model-id",
        "sampling": { "temperature": 0, "topP": 1, "seed": 7, "maxOutputTokens": 4096 }
      }
    }
  },
  "execution": {
    "splits": ["test"],
    "repetitions": 5,
    "seed": 20260830,
    "timeoutMs": 300000,
    "maxConcurrency": 1
  },
  "thresholds": {
    "minimumCandidateSuccessRate": 0.8,
    "minimumSuccessRateDelta": 0,
    "minimumMeanScoreDelta": 0.05,
    "maximumPairRegressionCount": 0,
    "maximumTaskRegressionCount": 0,
    "maximumMeanDurationRegressionRatio": 0.2,
    "maximumP95DurationRegressionRatio": 0.2,
    "maximumMeanTotalTokensRegressionRatio": 0.1,
    "maximumMeanEstimatedCostRegressionRatio": 0.1,
    "requireNoSafetyRegression": true,
    "requireNoPrivacyRegression": true,
    "requireNoStabilityRegression": true
  }
}
```

case 将 `task` 交给进程，并把 `fixture` 复制到私有 workspace。`taskInput` 可为 `argument`（默认）、`stdin` 或 `none`。`{manifestDir}` 在运行时指向只包含已登记 artifacts 的私有快照，未列出的相对依赖会直接失败；`{workspace}` 指向当前 case 的世界状态。密钥值不能写进 `env`；真实模型运行应只在 `inheritEnv` 中列出所需变量名，并确保报告/fixture 不含密钥。`HOME`、`DSH_HOME`、临时目录、`NODE_OPTIONS` 和所有 `DSH_EVAL_*` 名称由评测器保留，大小写变体也不能覆盖。

完整字段与信任边界见 [架构说明](docs/ARCHITECTURE.md)，运行、清理和回滚见 [运维说明](docs/OPERATIONS.md)，当前证据见 [验收账本](docs/ACCEPTANCE.md)。可执行样例位于 [`examples/`](examples/)。

## 评测 DSH

DSH 的受支持应用入口仍是命名 profile。variant 的版本化 runner 应在评测器提供的独立 `DSH_HOME` 中准备 profile，然后启动：

```text
dsh --profile headless --patch <baseline-or-candidate.cordis.yml> <task>
```

两侧 patch 必须加载真实 baseline/candidate 组合；若要采集自报 probe 指标，也要加载 `dsh-eval`。runner、patch、打包插件和 lockfile 都应列入 `artifacts`，`entryArtifact` 指向实际启动的版本化 runner。对于 SDK 多轮任务，runner 应使用公开 `@deepseek-ai/dsh-sdk-client` 并在每次 case 后 `await harness.close()`；不要内嵌上游 Cordis 树或访问 DSH 私有源码。真实晋级还要由容器/VM 外部观察 session/billing，当前本地 token/cost gate 会有意失败关闭。

## 已知限制

- 本地进程与路径隔离不是安全沙箱。恶意候选仍拥有评测器用户的文件权限；不可信候选必须在容器或 VM 中运行。未来外部 runner 可接 Harbor，但核心不嵌入 Python。
- probe 文件路径和身份字段对被测进程可见，因此指标可伪造；同时没有形成 durable usage 的 provider 重试可能漏计。它只用于诊断，不能成为本地晋级门槛。
- timeout/取消会回收已知进程树；Windows 上顶层进程正常退出后自行脱离的后代无法由 Node `spawn` 可靠收容。此类 runner 必须使用外部 Job Object/容器监督，报告会保留该 promotion blocker。
- trusted script 是 evaluator-controlled Oracle，但当前在本机克隆 workspace 中执行，不是容器 verifier。
- 当前仓库未运行真实模型评测、Unix 矩阵、容器隔离或 canary；这些状态不会被 keyless 报告替代。
- 当前相邻 DSH 的源码 CLI 与 built SDK 真实进程组合验证使用本地 mock 上游，probe 仍是被测进程自报；它们只证明入口兼容性，详见验收账本及 `evals/reports/dsh-real-process-latest.json`。
