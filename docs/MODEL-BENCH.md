# Otari model benchmark (2026-11-10)

A quick check of the open-weight models for each HackPilot role, run through `api.otari.ai` with the app's real prompts and schemas. Each model ran 2 times per role at temperature 0.2. The raw replies, the ground truth and the scoring rules are in [`model-bench.json`](model-bench.json). The whole run cost **$0.014** of Otari credit (52 calls).

Input: the real DoraHacks page for Mozilla Devs Wilding, with the linked rubric doc appended, since the weights (30 / 60 / 10) are only in that doc. The app's own heuristic draft went into the import prompt, as `extractFromPage` does.

Latency is the median. Cost is `usage.cost_usd` per call.

## Import (page → JSON), role `extract`

Quality is field accuracy against hand-built ground truth, averaged over name, deadline, prizes, rubric and requirements (0–1).

| Model | Success | Quality | Latency | Cost/call | Notes |
| --- | --- | --- | --- | --- | --- |
| alibaba/qwen3-235b-a22b-instruct-2507 | 2/2 | **0.85** | 14.2 s | $0.00049 | The only model that captured all 7 submission requirements. Kept the $1,200 "Prize Pool" and the $20 sign-up credit as prizes. Deadline 23:59 UTC (from the body text). |
| deepseek/deepseek-v4-flash | 2/2 | 0.81 | **3.9 s** | **$0.00016** | Prizes and rubric exactly right. Requirements were only the 2 DoraHacks badges (repo, demo video). Deadline 23:59 UTC. |
| alibaba/qwen3-30b-a3b-instruct-2507 (current) | 2/2 | 0.81 | 13.5 s | $0.00032 | Deadline 16:59 UTC (right). Counted the $20 credit as a prize. Requirements were only the 2 badges. |
| openai/gpt-oss-20b | 2/2 | 0.76 | 29.5 s | $0.00052 | Good requirements (6/7). Split the rubric into 11–12 sub-criteria instead of 30/60/10. |
| nvidia/nemotron-3-nano-30b-a3b | 2/2 | 0.75 | 25.6 s | $0.00087 | Inconsistent between runs: the rubric was right once and split once. Requirements were one vague "Submission" item. |

## Ideas, role `ideas`

I rated the ideas by hand from 1 to 5 on specificity, rubric fit, whether a solo dev could build it in under 15 hours, and whether the model's own scores are usable.

| Model | Success | Quality (1–5) | Latency | Cost/call | Notes |
| --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-v4-flash | 2/2 | **3.4** | 11.8 s | **$0.00016** | Generic ideas (research assistant, code review), but each one maps explicitly to rubric features. Self-scores are inflated (7–9). |
| alibaba/qwen3-235b-a22b-instruct-2507 (current) | 2/2 | 3.0 | 13.3 s | $0.00050 | The most concrete pitches. But its self-scores use the wrong scale (3/6/2, which is weight ÷ 10), so every idea ties. It also names models Otari may not host. |
| openai/gpt-oss-120b | 2/2 | 3.0 | 41.5 s | $0.00027 | Generic ideas that name old models (Llama-2, Phi-2). One run barely mentions Otari features. |
| moonshotai/kimi-k2.6 | 0/2 | n/a | >105 s | n/a | Timed out twice. The app gives up at 90 s. Skipped. |
| z-ai/glm-4.7 | 0/2 | n/a | >105 s | n/a | Timed out twice. Skipped. |

## Scoring, role `judge`

Each model scored a strong idea (HackPilot) and a weak one (a single-model chat wrapper) twice. "Sane" means the strong idea beats the weak one on weighted score and the weak one gets ≤3 on Otari features.

| Model | Success | Weighted strong / weak (run 1; run 2) | Max diff between runs | Sane | Latency | Cost/call |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek/deepseek-v4-flash (current) | 4/4 | 8.1 / 1.8; 8.5 / 1.8 | 1 | ✅ | **2.3 s** | **$0.00009** |
| openai/gpt-oss-120b | 4/4 | 10.0 / 1.8; 10.0 / 2.6 | 2 | ✅ (gave the strong idea 10/10/10, so poorly calibrated) | 12.5 s | $0.00015 |
| alibaba/qwen3-235b-a22b-instruct-2507 (current fallback) | 4/4 | 7.1 / 8.0; 7.1 / 8.0 | 0 | ❌ gave the chat wrapper 10 on Otari features | 2.4 s | $0.00020 |
| alibaba/qwen3-30b-a3b-instruct-2507 | 4/4 | 7.1 / 1.5; 7.1 / 7.1 | 9 | ❌ | 2.8 s | $0.00020 |

## Tool calling, Pilot chat

There were two scenarios, 2 runs each. In the first, after a `get-hackathon` result, the user asks to move the demo-video task to Demo-ready and check it off; the right call is `update-task {id, milestone:"demo", done:true}`. In the second, the user asks to create a task under Submitted for tomorrow; the right call is `update-task {hackathonId, title, milestone:"submit", day}`.

| Model | Correct | Latency | Cost/call | Notes |
| --- | --- | --- | --- | --- |
| alibaba/qwen3-235b-a22b-instruct-2507 (current) | 4/4 | **1.8 s** | $0.00011 | Clean. |
| deepseek/deepseek-v4-flash | 4/4 | 2.2 s | $0.00006 | Clean. |
| openai/gpt-oss-120b | 4/4 | 3.5 s | **$0.00005** | Clean but slower. |
| moonshotai/kimi-k2.6 | 3/4 | 5.0 s | $0.00058 | Moved the wrong task (`t_101`) once. Costs 5–10x more. |

All models set `estimateHours: 1` and produced valid JSON arguments.

## Recommendations

| Role | Recommended | Fallback | Change from current? |
| --- | --- | --- | --- |
| extract (import) | `alibaba/qwen3-235b-a22b-instruct-2507`: best field accuracy, and the only one that gets the full submission checklist. Import runs once, so 14 s is fine. | `deepseek/deepseek-v4-flash`: same score as the current model at 3.5x the speed and half the cost. | **Yes.** The current `qwen3-30b` scores no better than deepseek, is slower, and counts the sign-up credit as a prize. Keep `qwen3-30b` third. Drop nemotron and gpt-oss-20b. |
| ideas | `deepseek/deepseek-v4-flash`: ideas tied to the rubric, cheapest, and its self-scores at least separate the ideas. | `alibaba/qwen3-235b-a22b-instruct-2507`: better pitches, but its self-scores are broken. | **Weak yes.** A prompt line like "each score is 0–10 regardless of the criterion's weight" might make qwen3-235b the pick again. That is untested. |
| judge | `deepseek/deepseek-v4-flash`: consistent, sane, fastest and cheapest. | `openai/gpt-oss-120b`: sane but over-generous to strong ideas. | **Keep the primary, change the fallback.** qwen3-235b failed the sanity check. |
| chat (tools) | `alibaba/qwen3-235b-a22b-instruct-2507`: 4/4 and the fastest. | `deepseek/deepseek-v4-flash`: 4/4 and half the cost. | **Keep, and add a fallback.** There is currently none. |

The caveats: 2 runs per model and a single hackathon page is a small sample. The ideas ratings are one person's judgement. Kimi and GLM may work with a longer timeout or streaming, but they do not fit the app's current 90 s limit.
