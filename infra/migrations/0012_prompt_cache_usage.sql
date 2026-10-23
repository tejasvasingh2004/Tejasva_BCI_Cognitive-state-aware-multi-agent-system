-- Prompt tokens the provider served from its prompt cache (a subset of prompt_tokens), so usage can
-- show how much of the input was cached and cost can use the cache-read price.
ALTER TABLE model_calls ADD COLUMN cached_prompt_tokens integer;
