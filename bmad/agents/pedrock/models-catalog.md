# Bedrock Models Catalog

_Last Updated: 2026-02-04_
_Next Review: 2026-03-01_
_Verification: aws.amazon.com/bedrock/pricing_

---

## Anthropic Claude Family

### Claude 3.5 Sonnet v2 (RECOMMENDED for most use cases)

- **Model ID**: `anthropic.claude-3-5-sonnet-20241022-v2:0`
- **Context Window**: 200K tokens
- **Max Output**: 8,192 tokens
- **Strengths**: Excellent balance of reasoning, speed, and cost; strong coding; good vision
- **Best For**: General RAG, document analysis, coding assistance, most production workloads
- **Weaknesses**: Not the cheapest for high-volume simple tasks
- **Pricing Tier**: Mid-range
- **Vision**: Yes

### Claude 3.5 Haiku

- **Model ID**: `anthropic.claude-3-5-haiku-20241022-v1:0`
- **Context Window**: 200K tokens
- **Max Output**: 8,192 tokens
- **Strengths**: Fast, cost-effective, surprisingly capable for size
- **Best For**: High-volume tasks, latency-sensitive apps, triage/routing, chat
- **Weaknesses**: Less nuanced reasoning than Sonnet
- **Pricing Tier**: Economy
- **Vision**: Yes

### Claude 3 Opus

- **Model ID**: `anthropic.claude-3-opus-20240229-v1:0`
- **Context Window**: 200K tokens
- **Max Output**: 4,096 tokens
- **Strengths**: Deepest reasoning, complex analysis, nuanced writing
- **Best For**: Complex multi-step reasoning, research synthesis, high-stakes decisions
- **Weaknesses**: Expensive, slower, often overkill
- **Pricing Tier**: Premium
- **Vision**: Yes
- **Note**: Consider Sonnet first — Opus is rarely necessary

### Claude Opus 4

- **Model ID**: `anthropic.claude-opus-4-20250514-v1:0`
- **Context Window**: 200K tokens
- **Max Output**: 16,000 tokens
- **Strengths**: State-of-the-art reasoning, agentic workflows, extended thinking
- **Best For**: Most complex tasks, agentic systems requiring autonomy
- **Weaknesses**: Highest cost tier
- **Pricing Tier**: Ultra-Premium
- **Vision**: Yes

### Claude Sonnet 4

- **Model ID**: `anthropic.claude-sonnet-4-20250514-v1:0`
- **Context Window**: 200K tokens
- **Max Output**: 16,000 tokens
- **Strengths**: Excellent reasoning with better cost efficiency than Opus 4
- **Best For**: Production workloads needing strong reasoning
- **Pricing Tier**: Mid-Premium
- **Vision**: Yes

---

## Meta Llama Family

### Llama 3.1 405B Instruct

- **Model ID**: `meta.llama3-1-405b-instruct-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Largest open-weight model, strong general performance
- **Best For**: When you need open-weight for compliance/audit, general tasks
- **Weaknesses**: Expensive for open model, no vision
- **Pricing Tier**: Premium
- **Custom Import**: Can also self-host via Custom Model Import

### Llama 3.1 70B Instruct

- **Model ID**: `meta.llama3-1-70b-instruct-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Good balance of capability and cost in Llama family
- **Best For**: Open-weight requirements with reasonable budget
- **Pricing Tier**: Mid-range

### Llama 3.1 8B Instruct

- **Model ID**: `meta.llama3-1-8b-instruct-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Small, fast, cheap
- **Best For**: Simple tasks, edge cases, experimentation
- **Pricing Tier**: Economy

---

## Mistral Family

### Mistral Large 2

- **Model ID**: `mistral.mistral-large-2407-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Strong multilingual, good reasoning, European company (GDPR considerations)
- **Best For**: Multilingual workloads, EU data residency preference
- **Pricing Tier**: Mid-range

### Mixtral 8x7B

- **Model ID**: `mistral.mixtral-8x7b-instruct-v0:1`
- **Context Window**: 32K tokens
- **Strengths**: Efficient MoE architecture, good performance/cost
- **Best For**: General tasks with cost sensitivity
- **Pricing Tier**: Economy

---

## Amazon Titan Family

### Titan Text Premier

- **Model ID**: `amazon.titan-text-premier-v1:0`
- **Context Window**: 32K tokens
- **Strengths**: AWS-native, good for RAG, no third-party data concerns
- **Best For**: When keeping data fully within AWS ecosystem matters
- **Pricing Tier**: Mid-range

### Titan Embeddings V2 (RECOMMENDED for embeddings)

- **Model ID**: `amazon.titan-embed-text-v2:0`
- **Dimensions**: 1024 (configurable: 256, 512, 1024)
- **Max Input**: 8,192 tokens
- **Strengths**: Excellent for RAG, configurable dimensions, normalize option
- **Best For**: Knowledge Base embeddings, semantic search
- **Pricing Tier**: Economy
- **Note**: Default choice for Bedrock Knowledge Bases

### Titan Multimodal Embeddings

- **Model ID**: `amazon.titan-embed-image-v1:0`
- **Dimensions**: 1024
- **Strengths**: Embed both text and images in same vector space
- **Best For**: Image search, multimodal RAG
- **Pricing Tier**: Economy

### Titan Image Generator

- **Model ID**: `amazon.titan-image-generator-v1`
- **Strengths**: AWS-native image generation, good for enterprise
- **Best For**: Image generation when keeping data in AWS matters
- **Pricing Tier**: Mid-range

---

## Cohere Family

### Cohere Command R+

- **Model ID**: `cohere.command-r-plus-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Optimized for RAG, strong tool use, good citations
- **Best For**: RAG workloads needing strong grounding, tool use
- **Pricing Tier**: Mid-range

### Cohere Embed English v3

- **Model ID**: `cohere.embed-english-v3`
- **Dimensions**: 1024
- **Strengths**: Excellent retrieval quality, search-optimized
- **Best For**: English-only RAG with highest retrieval quality needs
- **Pricing Tier**: Economy

### Cohere Embed Multilingual v3

- **Model ID**: `cohere.embed-multilingual-v3`
- **Dimensions**: 1024
- **Strengths**: 100+ languages in same embedding space
- **Best For**: Multilingual search and RAG
- **Pricing Tier**: Economy

---

## DeepSeek Family

### DeepSeek R1

- **Model ID**: `deepseek.deepseek-r1-v1:0`
- **Context Window**: 128K tokens
- **Strengths**: Strong reasoning, chain-of-thought, cost-effective
- **Best For**: Reasoning tasks, math, code, when cost matters
- **Weaknesses**: Newer model, less production track record
- **Pricing Tier**: Economy-Mid
- **Note**: Good alternative to Claude for reasoning at lower cost

---

## Stability AI

### Stable Diffusion XL

- **Model ID**: `stability.stable-diffusion-xl-v1`
- **Strengths**: High-quality image generation, well-understood model
- **Best For**: Image generation, creative content
- **Pricing Tier**: Mid-range

---

## Model Selection Quick Reference

| Use Case            | Primary Recommendation      | Budget Alternative  |
| ------------------- | --------------------------- | ------------------- |
| General RAG         | Claude 3.5 Sonnet           | Llama 3.1 70B       |
| High-volume chat    | Claude 3.5 Haiku            | Llama 3.1 8B        |
| Complex reasoning   | Claude Sonnet 4             | DeepSeek R1         |
| Document embeddings | Titan Embeddings V2         | Cohere Embed        |
| Multilingual        | Mistral Large 2             | Cohere Multilingual |
| Image search        | Titan Multimodal Embeddings | -                   |
| Image generation    | Titan Image Generator       | Stable Diffusion XL |
| EU data preference  | Mistral Large 2             | -                   |

---

## Region Availability Note

Not all models are available in all regions. Key considerations:

- **US regions (us-east-1, us-west-2)**: Broadest availability
- **EU regions (eu-west-1, eu-central-1)**: Check specific model availability
- **Newer models**: Often US-first, EU follows

Always verify availability in your target region via the Bedrock console.
