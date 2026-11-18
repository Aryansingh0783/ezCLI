# Tool-use fine-tune for local models

Teaches a local model (Qwen3-8B) when to use ezCLI's tools and how to ask for them: a one-line `SEARCH:` only for
facts newer than its training, `IMAGE:`/`VIDEO:` when asked for a picture or clip, `RUN:` only for things on the
user's PC, and a plain answer for everything it already knows. The result is a LoRA adapter (about 100 MB) that
llama.cpp loads on top of the unchanged Qwen3-8B GGUF.

| Step | Script | Needs |
| --- | --- | --- |
| 1. Make the questions | `make_dataset.py` | nothing |
| 2. Fill in direct answers from the model itself | `distill.py` | llama-server with the Qwen3-8B GGUF |
| 3. Train | `train.py` | CUDA GPU, 12 GB is enough (4-bit QLoRA), original Qwen3-8B weights |
| 4. Convert | `convert.ps1` | llama.cpp source (`convert_lora_to_gguf.py`) |
| 5. Compare | `eval.py --label base` / `--label tuned` | llama-server without / with `--lora` |

Held-out questions (`data/heldout.jsonl`) are split by question, so the score is on questions never trained on.
The tool note in `make_dataset.py` must match `hint()` in `src/features/websearch.ts`; change both together.
