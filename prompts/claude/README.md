# Claude prompt

Claude is the second independent provider. Its operational prompt is versioned here as
[`v1.1.0.md`](v1.1.0.md) and is a 1:1 adaptation of the ChatGPT prompt
[`prompts/chatgpt/v1.1.0.md`](../chatgpt/v1.1.0.md): identical schema, ranges, action
mapping and publication contract, differing only in provider-specific tokens
(`provider=claude`, `providers/claude/**` ownership, canonical prompt path). This keeps
the two providers' outputs directly comparable.

The prompt is run by an external scheduled Claude publisher. Do not add fake Claude
assessments merely to populate the UI — only a real publisher run may write provider state.
