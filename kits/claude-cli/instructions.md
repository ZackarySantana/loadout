Use `--model opus` by default for Claude CLI; use `--model fable` only when asked. Start with `claude -p --model opus --output-format json "PROMPT"` and capture `session_id` from the response.
For follow-ups, run `claude -p --resume SESSION_ID --model opus --output-format json "FOLLOW-UP"` in the same working directory; substitute `fable` in both commands when requested.
