# dsh-reasoning-picker

A composer button for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that answers one question before you hit send: **how much model do I actually need for this draft?**

Click the 📊 button next to the send action. The plugin reads your draft (plus the last few turns of the conversation), asks a cheap model to judge the difficulty, and shows a recommendation — **Flash** or **Pro**, plus the reasoning effort, plus a one-line reason. Nothing changes until you click **应用 (Apply)**, and it never sends the message for you.

The point is to stop paying for `Pro · High` on "rename this variable" while still getting `Pro` when the task deserves it.

## Install

```sh
dsh plugin add dsh-reasoning-picker
```

Then restart DSH (or reload the page) so the client half is loaded. The button appears in the composer toolbar, to the right of the input box.

## How it works

| Step | What happens |
| --- | --- |
| 1 | You type a draft and click 📊 |
| 2 | The host reads the draft and the last few messages of the session |
| 3 | A small model picks the cheapest level that fits, from a ladder built from the models you actually have |
| 4 | A small panel shows `Flash · Off` / `Pro · Low` … plus a one-line reason |
| 5 | You click **应用** — only then is that provider/model/effort applied to the current session |

- **Never auto-sends.** The draft stays in the box; you still press send.
- **Never auto-switches.** Evaluating alone changes nothing.
- **Uses your own model list.** The ladder is built from what `sessionController.modelCatalog()` reports, so it adapts to whatever providers you configured instead of assuming fixed tiers.
- The evaluator runs at the lowest effort the chosen model supports, so the estimate itself costs almost nothing.

## Configuration

The plugin works with zero configuration. Optional keys (in the bundle config):

| Key | Default | Meaning |
| --- | --- | --- |
| `flashModel` / `flashProvider` | auto-detect | Force the "cheap" tier |
| `proModel` / `proProvider` | auto-detect | Force the "strong" tier |
| `maxRecentMessages` | `6` | How many recent messages are fed to the evaluator |
| `maxRecentChars` | `1400` | Character budget for that recent context |
| `maxDraftChars` | `4000` | Draft is truncated to this length |
| `timeoutMs` | `15000` | Evaluator timeout |

## Privacy & safety

- Both HTTP routes are loopback-only and reject forwarded/origin-mismatched requests.
- The draft and recent context are sent to the model you already use through DSH's own `llm` service — no third-party endpoint.
- No telemetry, no network calls other than the model call you configured.

## License

MIT
