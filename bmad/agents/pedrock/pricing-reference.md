# Bedrock Pricing Reference

_Last Updated: 2026-02-04_
_Next Review: 2026-03-01_
_Verification: aws.amazon.com/bedrock/pricing_

---

## Pricing Models Overview

### On-Demand

- Pay per token (input/output priced separately)
- No commitment, no minimum
- Best for: Variable workloads, development, unpredictable usage

### Provisioned Throughput

- Reserved capacity (model units)
- 1-month or 6-month commitments
- Best for: Predictable high-volume production workloads
- Savings: 20-50% vs on-demand at scale

### Batch Inference

- Process large datasets asynchronously
- 50% discount vs on-demand
- Best for: Non-real-time bulk processing

---

## On-Demand Pricing (per 1,000 tokens)

### Anthropic Claude

| Model                | Input   | Output |
| -------------------- | ------- | ------ |
| Claude 3.5 Sonnet v2 | $0.003  | $0.015 |
| Claude 3.5 Haiku     | $0.0008 | $0.004 |
| Claude 3 Opus        | $0.015  | $0.075 |
| Claude Opus 4        | $0.015  | $0.075 |
| Claude Sonnet 4      | $0.003  | $0.015 |

### Meta Llama

| Model          | Input    | Output   |
| -------------- | -------- | -------- |
| Llama 3.1 405B | $0.00532 | $0.016   |
| Llama 3.1 70B  | $0.00099 | $0.00099 |
| Llama 3.1 8B   | $0.0003  | $0.0006  |

### Mistral

| Model           | Input    | Output  |
| --------------- | -------- | ------- |
| Mistral Large 2 | $0.004   | $0.012  |
| Mixtral 8x7B    | $0.00045 | $0.0007 |

### Amazon Titan

| Model                       | Input                             | Output  |
| --------------------------- | --------------------------------- | ------- |
| Titan Text Premier          | $0.0005                           | $0.0015 |
| Titan Embeddings V2         | $0.00002                          | N/A     |
| Titan Multimodal Embeddings | $0.0008 (image) / $0.00002 (text) | N/A     |

### Cohere

| Model                 | Input   | Output |
| --------------------- | ------- | ------ |
| Command R+            | $0.003  | $0.015 |
| Embed English v3      | $0.0001 | N/A    |
| Embed Multilingual v3 | $0.0001 | N/A    |

### DeepSeek

| Model       | Input    | Output  |
| ----------- | -------- | ------- |
| DeepSeek R1 | $0.00135 | $0.0054 |

---

## Cost Estimation Formulas

### Text Generation

```
Monthly Cost = (Input Tokens × Input Price + Output Tokens × Output Price) × Monthly Requests
```

### Embeddings

```
Monthly Cost = Total Tokens Embedded × Embedding Price
```

### RAG System Total Cost

```
Total = Embedding Cost + Storage Cost + Generation Cost + Retrieval Cost

Where:
- Embedding Cost = Documents × Avg Tokens × Embedding Price (one-time + incremental)
- Storage Cost = Vector DB charges (OpenSearch, Aurora, etc.)
- Generation Cost = Queries × (Input Tokens + Retrieved Context + Output Tokens) × Model Price
- Retrieval Cost = Vector DB query charges
```

---

## Cost Scenarios

### Scenario A: Low-Volume RAG Chatbot

- 10,000 queries/month
- 500 input tokens avg
- 1,000 context tokens (retrieved)
- 500 output tokens avg
- Model: Claude 3.5 Haiku

```
Input: 10,000 × (500 + 1,000) / 1000 × $0.0008 = $12.00
Output: 10,000 × 500 / 1000 × $0.004 = $20.00
Monthly Generation Cost: ~$32
```

### Scenario B: High-Volume Production RAG

- 500,000 queries/month
- 800 input tokens avg
- 2,000 context tokens
- 800 output tokens avg
- Model: Claude 3.5 Sonnet

```
Input: 500,000 × (800 + 2,000) / 1000 × $0.003 = $4,200
Output: 500,000 × 800 / 1000 × $0.015 = $6,000
Monthly Generation Cost: ~$10,200

With Provisioned Throughput (30% savings): ~$7,140
```

### Scenario C: Document Embedding (One-Time)

- 100,000 documents
- 2,000 tokens avg per document
- Model: Titan Embeddings V2

```
Total Tokens: 100,000 × 2,000 = 200,000,000
Cost: 200,000,000 / 1000 × $0.00002 = $4.00
```

---

## Vector Database Costs (for RAG)

### OpenSearch Serverless

- **OCU-hours**: $0.24/OCU-hour
- **Minimum**: 2 OCUs for indexing, 2 for search
- **Estimate**: ~$350/month minimum for always-on

### Aurora PostgreSQL (pgvector)

- **Serverless v2**: $0.12/ACU-hour
- **Scales to zero**: Yes (with delay)
- **Estimate**: $50-500/month depending on usage

### Pinecone (External)

- **Starter**: Free (limited)
- **Standard**: $70/month base
- **Enterprise**: Custom pricing

### Amazon MemoryDB (Redis)

- **On-Demand**: $0.016/GB-hour
- **Estimate**: Variable by data size

---

## Cost Optimization Strategies

### 1. Model Tiering

```
User Query → Haiku (classify/route) → Sonnet (if complex) → Opus (if very complex)

Savings: 40-60% vs using Sonnet for everything
```

### 2. Prompt Caching

- Reuse system prompts across requests
- Cache retrieved context for repeated queries
- Savings: Up to 90% on cached tokens

### 3. Semantic Caching

- Cache responses for semantically similar queries
- Use ElastiCache or DynamoDB
- Savings: Variable, high for repetitive queries

### 4. Right-Sizing Context

- Don't retrieve more chunks than needed
- Summarize long contexts before generation
- Savings: 20-40% on input tokens

### 5. Provisioned Throughput Thresholds

- Generally cost-effective above: ~$5,000/month on-demand
- 1-month commitment: ~20% savings
- 6-month commitment: ~40% savings

### 6. Batch Inference

- For non-real-time: 50% savings
- Good for: Nightly processing, bulk analysis

---

## When NOT to Use Bedrock

| Scenario                | Alternative         | Reasoning                |
| ----------------------- | ------------------- | ------------------------ |
| Simple keyword matching | OpenSearch/Elastic  | Don't need AI            |
| Rule-based routing      | Step Functions      | Deterministic is cheaper |
| Static FAQ responses    | DynamoDB lookup     | Cached responses         |
| <100 queries/month      | Consider free tiers | May not justify setup    |

---

## Pricing Verification Reminder

These prices are point-in-time estimates. For production cost planning:

1. Verify current prices at aws.amazon.com/bedrock/pricing
2. Use AWS Pricing Calculator for detailed estimates
3. Start with on-demand, analyze usage, then optimize
4. Set up AWS Budgets alerts before production launch
