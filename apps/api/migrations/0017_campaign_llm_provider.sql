-- A campaign can choose its own model from any VAPI provider (OpenAI,
-- Anthropic/Claude, Google, Groq). Null = use the agent's model.
alter table campaigns add column if not exists llm_provider text;
