# Platform Migration Patterns to Bedrock

_Reference for migrating from other AI platforms_
_Last Updated: 2026-02-04_

---

## Migration Assessment Framework

Before migrating, assess these dimensions:

| Dimension       | Questions to Answer                                       |
| --------------- | --------------------------------------------------------- |
| **Models**      | What models are you using? What capabilities do you need? |
| **APIs**        | What API patterns? Function calling? Streaming?           |
| **Volume**      | How many requests/month? Peak load?                       |
| **Data**        | Where is data stored? Sensitivity level?                  |
| **Integration** | What services integrate with current AI?                  |
| **Compliance**  | What regulations apply? Data residency needs?             |

---

## Migration Path 1: OpenAI API → Bedrock

### Model Mapping

| OpenAI Model           | Bedrock Equivalent       | Notes                                |
| ---------------------- | ------------------------ | ------------------------------------ |
| GPT-4 Turbo            | Claude 3.5 Sonnet        | Similar capability, different style  |
| GPT-4                  | Claude 3 Opus / Sonnet 4 | Opus for complex, Sonnet for general |
| GPT-3.5 Turbo          | Claude 3.5 Haiku         | Fast, cost-effective                 |
| text-embedding-ada-002 | Titan Embeddings V2      | Dimension difference (1536 → 1024)   |
| text-embedding-3-small | Titan Embeddings V2      | Good match                           |
| DALL-E 3               | Titan Image Generator    | Different capabilities               |

### API Translation

**OpenAI Chat Completion → Bedrock Converse API**

```python
# OpenAI Pattern
response = openai.ChatCompletion.create(
    model="gpt-4-turbo",
    messages=[
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hello"}
    ],
    max_tokens=1000,
    temperature=0.7
)
answer = response.choices[0].message.content

# Bedrock Converse API Pattern
response = bedrock.converse(
    modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages=[
        {"role": "user", "content": [{"text": "Hello"}]}
    ],
    system=[{"text": "You are helpful."}],
    inferenceConfig={
        "maxTokens": 1000,
        "temperature": 0.7
    }
)
answer = response['output']['message']['content'][0]['text']
```

### Function Calling → Tool Use

```python
# OpenAI Functions
functions = [{
    "name": "get_weather",
    "parameters": {...}
}]

# Bedrock Tool Use
toolConfig = {
    "tools": [{
        "toolSpec": {
            "name": "get_weather",
            "inputSchema": {"json": {...}}
        }
    }]
}
```

### Key Differences

| Aspect           | OpenAI             | Bedrock                 | Migration Impact        |
| ---------------- | ------------------ | ----------------------- | ----------------------- |
| System prompt    | In messages array  | Separate `system` field | Low - restructure       |
| Streaming        | Server-sent events | Response stream         | Low - different parsing |
| Function calling | `functions` param  | `toolConfig`            | Medium - restructure    |
| Token counting   | tiktoken library   | Model-specific          | Medium - new tooling    |
| Rate limits      | Per-org            | Per-account + quotas    | Review limits           |

### Embedding Migration

**Critical**: OpenAI embeddings are 1536 dimensions, Titan is 1024 (configurable).

Options:

1. **Re-embed everything** (recommended): Generate new embeddings with Titan
2. **Dimension adapter**: Train adapter layer (complex, not recommended)

```python
# You MUST re-embed. Different models = incompatible vector spaces.
# Plan for one-time re-embedding cost and time.
```

### Migration Complexity: MEDIUM

- API restructure: Low effort
- Prompt tuning: Medium effort (Claude has different personality)
- Embeddings: High effort (full re-embed required)
- Testing: Medium effort (validate quality parity)

---

## Migration Path 2: Azure OpenAI → Bedrock

### Additional Considerations

Azure OpenAI uses the same models as OpenAI, so model mapping is identical. Additional factors:

| Aspect            | Azure OpenAI          | Bedrock                  | Migration Impact           |
| ----------------- | --------------------- | ------------------------ | -------------------------- |
| Identity          | Azure AD / Entra      | AWS IAM                  | HIGH - new auth            |
| Networking        | Azure VNet            | AWS VPC                  | HIGH - new network         |
| Deployment        | Per-deployment models | On-demand or provisioned | Medium                     |
| Content filtering | Azure content filter  | Bedrock Guardrails       | Medium - reconfigure       |
| Logging           | Azure Monitor         | CloudWatch               | Medium - new observability |

### Recommended Approach

1. **Phase 1**: Migrate API integration (keep existing infra)
2. **Phase 2**: Migrate data/embeddings (with AWS Architect support)
3. **Phase 3**: Migrate infrastructure (defer to AWS Solutions Architect)
4. **Phase 4**: Decommission Azure resources

### Migration Complexity: HIGH

- Includes all OpenAI API migration effort
- Plus infrastructure migration (needs AWS Solutions Architect)
- Plus identity/auth migration
- Plus networking changes

---

## Migration Path 3: Google Vertex AI → Bedrock

### Model Mapping

| Vertex Model       | Bedrock Equivalent     | Notes                      |
| ------------------ | ---------------------- | -------------------------- |
| Gemini 1.5 Pro     | Claude 3.5 Sonnet      | Similar capability tier    |
| Gemini 1.5 Flash   | Claude 3.5 Haiku       | Fast/cheap tier            |
| PaLM 2             | Claude 3 Opus / Sonnet | Depends on task            |
| text-embedding-004 | Titan Embeddings V2    | Dimension: 768 → 1024      |
| Imagen             | Titan Image Generator  | Different style/capability |

### API Translation

Vertex uses different SDK patterns:

```python
# Vertex AI Pattern
from vertexai.generative_models import GenerativeModel
model = GenerativeModel("gemini-1.5-pro")
response = model.generate_content("Hello")
answer = response.text

# Bedrock Pattern
response = bedrock.converse(
    modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}]
)
answer = response['output']['message']['content'][0]['text']
```

### Key Differences

| Aspect             | Vertex AI        | Bedrock                            | Migration Impact              |
| ------------------ | ---------------- | ---------------------------------- | ----------------------------- |
| Multi-modal input  | Native in Gemini | Claude vision, separate for others | Low                           |
| Grounding (search) | Vertex AI Search | Bedrock Knowledge Bases            | HIGH - different architecture |
| Context caching    | Vertex caching   | Not native (implement yourself)    | Medium                        |
| Tuning             | Vertex tuning    | Custom Model Import                | HIGH - different approach     |

### Migration Complexity: HIGH

- Different SDK paradigms
- Different RAG architecture (Vertex AI Search vs KB)
- Re-embedding required
- GCP-specific integrations (BigQuery, etc.) need replacement

---

## Migration Path 4: Self-Hosted (Ollama/vLLM/HuggingFace) → Bedrock

### Decision Framework

| Self-Hosted Scenario    | Bedrock Path                          |
| ----------------------- | ------------------------------------- |
| Running Llama models    | Use Bedrock Llama (easiest)           |
| Running Mistral models  | Use Bedrock Mistral (easiest)         |
| Custom fine-tuned model | Custom Model Import                   |
| Unusual open model      | Bedrock Marketplace or Custom Import  |
| Need exact same model   | Custom Model Import with your weights |

### Custom Model Import Process

```
1. Export model weights (Hugging Face format or safetensors)
2. Upload to S3 bucket
3. Create Custom Model Import job
4. Specify model architecture (Llama, Mistral, Flan-T5)
5. Wait for import validation
6. Invoke via standard Bedrock API
```

### Cost-Benefit Analysis

| Aspect               | Self-Hosted      | Bedrock Managed       |
| -------------------- | ---------------- | --------------------- |
| Infrastructure       | You manage       | AWS manages           |
| Scaling              | Manual           | Automatic             |
| Availability         | Your SLA         | AWS SLA               |
| GPU costs            | EC2/EKS          | Per-token             |
| Operational overhead | HIGH             | LOW                   |
| Cost at low volume   | Fixed infra cost | Pay-per-use (cheaper) |
| Cost at high volume  | May be cheaper   | May be more expensive |

**Break-even analysis**: Self-hosted typically cheaper above ~$10K-20K/month Bedrock spend, but factor in ops overhead.

### Migration Complexity: LOW-MEDIUM

- If using standard models: LOW (just point to Bedrock)
- If using custom models: MEDIUM (Custom Import process)
- If heavily customized inference: HIGH (may lose optimizations)

---

## Migration Path 5: SageMaker Endpoints → Bedrock

### When to Migrate

| Scenario                                         | Recommendation                                     |
| ------------------------------------------------ | -------------------------------------------------- |
| Using SageMaker for Hugging Face models          | Migrate to Bedrock Marketplace                     |
| Using SageMaker for custom training + inference  | Keep SageMaker for training, Bedrock for inference |
| Using SageMaker for fine-tuned foundation models | Consider Custom Model Import                       |
| Heavy MLOps pipeline integration                 | Hybrid approach                                    |

### Bedrock Marketplace

SageMaker-backed models available through Bedrock console:

- Deploy open models with SageMaker infrastructure
- Bedrock API interface
- Managed scaling

### Migration Complexity: MEDIUM

- API changes: Low (if using Bedrock API)
- MLOps integration: May need adjustment
- Cost model: Different (endpoint hours vs tokens)

---

## Migration Checklist Template

```markdown
## Migration Assessment: [Source Platform] → Bedrock

### Current State

- [ ] Document current models in use
- [ ] Document API patterns used
- [ ] Document monthly request volume
- [ ] Document latency requirements
- [ ] Document current costs
- [ ] Inventory integrations

### Model Mapping

- [ ] Map each model to Bedrock equivalent
- [ ] Identify capability gaps
- [ ] Plan for prompt tuning (model personality differences)

### Embedding Migration

- [ ] Calculate re-embedding scope (document count, tokens)
- [ ] Estimate re-embedding cost and time
- [ ] Plan vector database migration or replacement
- [ ] Schedule re-indexing downtime/parallel run

### API Migration

- [ ] Update SDK/client libraries
- [ ] Refactor API calls to Bedrock patterns
- [ ] Implement new authentication (IAM)
- [ ] Update error handling for Bedrock errors

### Testing

- [ ] Quality parity testing (same inputs, compare outputs)
- [ ] Performance benchmarking
- [ ] Cost validation
- [ ] Integration testing

### Rollout

- [ ] Parallel run period
- [ ] Gradual traffic shift
- [ ] Rollback plan
- [ ] Monitoring setup

### Handoffs Required

- [ ] AWS Solutions Architect: Infrastructure/networking
- [ ] Security team: IAM policies, data handling
- [ ] Compliance: Regulatory review of new platform
```

---

## Migration Cost Estimation

### One-Time Costs

| Item                   | Calculation                           |
| ---------------------- | ------------------------------------- |
| Re-embedding documents | Documents x Tokens x Embedding price  |
| Development effort     | Engineering hours x rate              |
| Testing                | QA hours x rate                       |
| Parallel run           | Both platforms running simultaneously |

### Ongoing Cost Comparison

Build a spreadsheet comparing:

- Current platform monthly cost
- Projected Bedrock monthly cost
- Net monthly difference
- Payback period for migration investment

---

## When NOT to Migrate

| Scenario                                       | Recommendation                       |
| ---------------------------------------------- | ------------------------------------ |
| Heavy investment in platform-specific features | Evaluate switching cost carefully    |
| Contractual commitments                        | Wait for contract end                |
| Platform provides unique capability            | May not have Bedrock equivalent      |
| Very low volume (<$100/month)                  | Migration effort may not be worth it |
| Working well, no issues                        | "If it ain't broke..."               |
