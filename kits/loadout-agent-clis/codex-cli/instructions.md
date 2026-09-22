Use `--model gpt-5.6-sol` by default; use `--model gpt-6-astra` only when asked. Start with `codex exec --model gpt-5.6-sol --json "PROMPT"` and capture `thread_id` from the output.
For follow-ups, run `codex exec resume --model gpt-5.6-sol --json SESSION_ID "FOLLOW-UP"` in the same working directory; substitute `gpt-6-astra` in both commands when requested.
