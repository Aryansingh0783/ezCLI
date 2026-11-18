"""QLoRA fine-tune of Qwen3-8B on data/train.jsonl, sized for a 12 GB GPU.

The base model is loaded in 4-bit, a LoRA adapter (rank 16 on every attention and MLP projection) is trained on the
replies only, and the adapter is saved to out/adapter. convert.ps1 turns it into a GGUF that llama.cpp
loads on top of the existing Qwen3-8B GGUF with --lora.

Run:  python train.py [--base D:\\ezcli-finetune\\Qwen3-8B] [--epochs 2]
"""
import argparse
import json
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=str(HERE.parent / "Qwen3-8B"))
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--out", default=str(HERE / "out"))
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(HERE / "data" / "train.jsonl", encoding="utf-8")]
    # prompt + completion: the loss is on the reply only, never on ezCLI's long tool note
    ds = Dataset.from_list([{"prompt": r["messages"][:1], "completion": r["messages"][1:]} for r in rows]).shuffle(seed=7)

    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForCausalLM.from_pretrained(
        a.base,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
        attn_implementation="sdpa",
    )
    lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    cfg = SFTConfig(
        output_dir=a.out,
        num_train_epochs=a.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=10,
        save_strategy="epoch",
        bf16=True,
        gradient_checkpointing=True,
        max_length=2048,
        completion_only_loss=True,
        report_to="none",
        seed=7,
    )
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
    trainer.train()
    trainer.model.save_pretrained(Path(a.out) / "adapter")
    tok.save_pretrained(Path(a.out) / "adapter")
    print("saved", Path(a.out) / "adapter")


if __name__ == "__main__":
    main()
