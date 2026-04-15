# Pedrock Diagnostic Decision Trees

_Reference for troubleshooting Bedrock architectures_
_Last Updated: 2026-02-04_

---

## Tree 1: RAG Quality Issues

### Symptom: "The RAG gives wrong or irrelevant answers"

```
START: User reports poor answer quality
│
├─ Q1: Does the correct information exist in your source documents?
│  │   HOW TO CHECK: Review source docs for the specific information
│  │
│  ├─ NO → DIAGNOSIS: Content Gap
│  │       ├─ ACTION: Add missing content to source documents
│  │       ├─ ACTION: Re-sync Knowledge Base after adding content
│  │       └─ VERIFY: Query again after sync completes
│  │
│  └─ YES → Continue to Q2
│
├─ Q2: Has the content been ingested into the Knowledge Base?
│  │   HOW TO CHECK: Knowledge Base console → Data sources → Sync status
│  │
│  ├─ NO → DIAGNOSIS: Ingestion Failure
│  │       ├─ CHECK: Sync job errors in console
│  │       ├─ CHECK: Document format compatibility (PDF, DOCX, TXT, HTML, MD, CSV)
│  │       ├─ CHECK: File size limits (50MB per file)
│  │       └─ ACTION: Fix issues and re-sync
│  │
│  └─ YES → Continue to Q3
│
├─ Q3: Is the content chunked appropriately?
│  │   HOW TO CHECK: Test retrieval, examine returned chunks
│  │
│  ├─ CHUNKS TOO SMALL → DIAGNOSIS: Chunking Strategy Issue
│  │       ├─ SYMPTOM: Chunks lack context, partial sentences
│  │       ├─ ACTION: Increase chunk size (try 500-1000 tokens)
│  │       └─ ACTION: Consider semantic chunking for better boundaries
│  │
│  ├─ CHUNKS TOO LARGE → DIAGNOSIS: Chunking Strategy Issue
│  │       ├─ SYMPTOM: Chunks contain unrelated information, diluted relevance
│  │       ├─ ACTION: Decrease chunk size (try 200-500 tokens)
│  │       └─ ACTION: Add overlap (10-20%) to maintain context
│  │
│  └─ CHUNKS SEEM OK → Continue to Q4
│
├─ Q4: Does retrieval return the relevant chunks?
│  │   HOW TO CHECK: Use RetrieveAPI directly (not RetrieveAndGenerate)
│  │   Examine the returned chunks and relevance scores
│  │
│  ├─ NO RELEVANT CHUNKS RETURNED → DIAGNOSIS: Retrieval Failure
│  │       ├─ CAUSE A: Wrong embedding model for content type
│  │       │   └─ ACTION: Try different embedding (Titan vs Cohere)
│  │       ├─ CAUSE B: Similarity threshold too high
│  │       │   └─ ACTION: Lower threshold or use more results (higher k)
│  │       ├─ CAUSE C: Query-document semantic mismatch
│  │       │   └─ ACTION: Add query expansion, use HyDE technique
│  │       └─ CAUSE D: Metadata filtering excluding results
│  │           └─ ACTION: Review filter configuration
│  │
│  └─ RELEVANT CHUNKS RETURNED → Continue to Q5
│
├─ Q5: Is the context reaching the generation model correctly?
│  │   HOW TO CHECK: Enable logging, examine full prompt sent to model
│  │
│  ├─ NO → DIAGNOSIS: Pipeline Integration Issue
│  │       ├─ CHECK: RetrieveAndGenerate configuration
│  │       ├─ CHECK: Prompt template includes {context} placeholder
│  │       └─ ACTION: Review Knowledge Base → Model connection
│  │
│  └─ YES → Continue to Q6
│
└─ Q6: Is the model using the context in its response?
   │   HOW TO CHECK: Does response cite or reference the retrieved content?
   │
   ├─ MODEL IGNORES CONTEXT → DIAGNOSIS: Prompt Engineering Issue
   │       ├─ ACTION: Strengthen grounding instruction in system prompt
   │       ├─ EXAMPLE: "Base your answer ONLY on the provided context.
   │       │           If the context doesn't contain the answer, say so."
   │       ├─ ACTION: Add explicit citation requirements
   │       └─ ACTION: Reduce or remove prior knowledge instructions
   │
   └─ MODEL USES CONTEXT BUT STILL WRONG → DIAGNOSIS: Model Capability Mismatch
           ├─ The model may not understand your domain well
           ├─ ACTION: Try a more capable model (Haiku → Sonnet → Opus)
           ├─ ACTION: Consider few-shot examples in prompt
           └─ ACTION: For specialized domains, consider fine-tuning path
```

---

## Tree 2: Performance Issues

### Symptom: "Responses are too slow"

```
START: User reports high latency
│
├─ Q1: What is the total end-to-end latency?
│  │   HOW TO MEASURE: CloudWatch metrics, application logs
│  │
│  ├─ < 2 seconds → Generally acceptable for RAG
│  ├─ 2-5 seconds → Investigate, may be acceptable depending on use case
│  └─ > 5 seconds → Needs optimization → Continue diagnosis
│
├─ Q2: Where is the latency occurring?
│  │   HOW TO MEASURE: Break down timing for each component
│  │
│  ├─ RETRIEVAL SLOW (>500ms) → DIAGNOSIS: Vector Store Latency
│  │       ├─ CAUSE A: Cold start (OpenSearch Serverless)
│  │       │   └─ ACTION: Keep minimum OCUs warm, use provisioned
│  │       ├─ CAUSE B: Large index, unoptimized queries
│  │       │   └─ ACTION: Review index configuration, reduce k
│  │       ├─ CAUSE C: Network latency to vector store
│  │       │   └─ ACTION: Ensure same-region deployment, use VPC endpoints
│  │       └─ CAUSE D: Metadata filtering overhead
│  │           └─ ACTION: Optimize filter expressions, add indexes
│  │
│  ├─ GENERATION SLOW (>3s) → DIAGNOSIS: Model Latency
│  │       ├─ CAUSE A: Context too large
│  │       │   └─ ACTION: Reduce retrieved chunks, summarize context
│  │       ├─ CAUSE B: Output length too high
│  │       │   └─ ACTION: Set max_tokens limit, instruct concise responses
│  │       ├─ CAUSE C: Model cold start
│  │       │   └─ ACTION: Use Provisioned Throughput for consistent latency
│  │       ├─ CAUSE D: Model too powerful for task
│  │       │   └─ ACTION: Use faster model (Sonnet → Haiku)
│  │       └─ CAUSE E: Not using streaming
│  │           └─ ACTION: Enable response streaming for perceived speed
│  │
│  └─ BOTH SLOW → DIAGNOSIS: Architecture Review Needed
│          └─ ACTION: Consider caching, model tiering, async patterns
│
└─ Q3: Is latency consistent or variable?
   │
   ├─ VARIABLE (sometimes fast, sometimes slow) → DIAGNOSIS: Cold Starts
   │       ├─ ACTION: Provisioned Throughput for models
   │       ├─ ACTION: Keep-warm Lambda pattern
   │       └─ ACTION: OpenSearch Serverless minimum OCUs
   │
   └─ CONSISTENTLY SLOW → DIAGNOSIS: Architecture Bottleneck
           └─ ACTION: Full architecture review, identify bottleneck component
```

---

## Tree 3: Cost Issues

### Symptom: "Bedrock costs are higher than expected"

```
START: User reports cost overruns
│
├─ Q1: Where is the cost concentrated?
│  │   HOW TO CHECK: AWS Cost Explorer, filter by Bedrock
│  │
│  ├─ MODEL INFERENCE (highest usually) → Continue to Q2
│  ├─ VECTOR STORAGE → Continue to Q3
│  └─ BOTH HIGH → Address both
│
├─ Q2: What's driving model inference costs?
│  │
│  ├─ HIGH INPUT TOKENS → DIAGNOSIS: Context Bloat
│  │       ├─ CAUSE A: Retrieving too many chunks
│  │       │   └─ ACTION: Reduce k, use re-ranking to get better top results
│  │       ├─ CAUSE B: Large system prompts
│  │       │   └─ ACTION: Enable prompt caching, optimize prompt length
│  │       └─ CAUSE C: Including unnecessary context
│  │           └─ ACTION: Filter/summarize before sending to model
│  │
│  ├─ HIGH OUTPUT TOKENS → DIAGNOSIS: Verbose Responses
│  │       ├─ ACTION: Set max_tokens limit
│  │       ├─ ACTION: Instruct concise responses in system prompt
│  │       └─ ACTION: Review if full responses are needed
│  │
│  ├─ HIGH REQUEST VOLUME → DIAGNOSIS: Volume Optimization
│  │       ├─ ACTION: Implement response caching (semantic or exact)
│  │       ├─ ACTION: Batch similar requests
│  │       ├─ ACTION: Filter unnecessary requests (handle simple queries locally)
│  │       └─ ACTION: Consider Provisioned Throughput for volume discounts
│  │
│  └─ EXPENSIVE MODEL → DIAGNOSIS: Model Over-Provisioning
│          ├─ QUESTION: Does every request need this model?
│          ├─ ACTION: Implement model tiering (Haiku → Sonnet → Opus)
│          └─ ACTION: Use smaller model for simple queries
│
└─ Q3: What's driving storage costs?
   │
   ├─ OPENSEARCH SERVERLESS HIGH → DIAGNOSIS: OCU Over-Provisioning
   │       ├─ CHECK: Are you using more OCUs than needed?
   │       ├─ ACTION: Review minimum OCU settings
   │       └─ ACTION: Consider Aurora pgvector for cost-sensitive workloads
   │
   └─ S3 STORAGE HIGH → DIAGNOSIS: Data Retention
           ├─ ACTION: Review lifecycle policies
           └─ ACTION: Archive or delete old document versions
```

---

## Tree 4: Reliability Issues

### Symptom: "Getting errors or failures"

```
START: User reports errors
│
├─ Q1: What error are you seeing?
│  │
│  ├─ 429 (ThrottlingException) → DIAGNOSIS: Rate Limit Hit
│  │       ├─ IMMEDIATE: Implement exponential backoff with jitter
│  │       ├─ SHORT-TERM: Request quota increase via AWS Support
│  │       ├─ LONG-TERM: Provisioned Throughput for guaranteed capacity
│  │       └─ ALTERNATIVE: Implement request queuing
│  │
│  ├─ 500 (InternalServerError) → DIAGNOSIS: Service Issue
│  │       ├─ CHECK: AWS Service Health Dashboard
│  │       ├─ ACTION: Implement retry with backoff
│  │       ├─ ACTION: Implement fallback model chain
│  │       └─ ACTION: If persistent, open AWS Support case
│  │
│  ├─ 400 (ValidationException) → DIAGNOSIS: Request Issue
│  │       ├─ CHECK: Input token count within model limits
│  │       ├─ CHECK: Output max_tokens within model limits
│  │       ├─ CHECK: Request format matches API spec
│  │       └─ CHECK: Content policy violations (Guardrails)
│  │
│  ├─ 403 (AccessDeniedException) → DIAGNOSIS: Permission Issue
│  │       ├─ CHECK: IAM policy allows bedrock:InvokeModel
│  │       ├─ CHECK: Model access enabled in Bedrock console
│  │       ├─ CHECK: Resource-based policies
│  │       └─ ESCALATE: AWS Solutions Architect for IAM review
│  │
│  └─ Timeout → DIAGNOSIS: Request Duration Issue
│          ├─ CHECK: Lambda timeout (if using Lambda)
│          ├─ CHECK: API Gateway timeout (29s default)
│          ├─ ACTION: Implement streaming for long responses
│          └─ ACTION: Reduce context/output size
│
└─ Q2: Is it intermittent or consistent?
   │
   ├─ INTERMITTENT → DIAGNOSIS: Likely transient / capacity
   │       ├─ ACTION: Implement robust retry logic
   │       ├─ ACTION: Add circuit breaker pattern
   │       └─ ACTION: Implement fallback responses
   │
   └─ CONSISTENT → DIAGNOSIS: Configuration or limit issue
           └─ ACTION: Review specific error, fix root cause
```

---

## Tree 5: Knowledge Base Sync Issues

### Symptom: "New documents not appearing in responses"

```
START: Recently added content not being retrieved
│
├─ Q1: Has the sync job completed?
│  │   HOW TO CHECK: Knowledge Base console → Data sources → Sync history
│  │
│  ├─ SYNC IN PROGRESS → Wait for completion
│  ├─ SYNC FAILED →
│  │       ├─ CHECK: Error message in sync details
│  │       ├─ COMMON: S3 permissions, file format issues
│  │       └─ ACTION: Fix issue, re-trigger sync
│  └─ SYNC SUCCEEDED → Continue to Q2
│
├─ Q2: Was the specific document processed?
│  │   HOW TO CHECK: Sync details → Document count
│  │
│  ├─ NOT IN COUNT → DIAGNOSIS: Document Not Ingested
│  │       ├─ CHECK: File format supported?
│  │       ├─ CHECK: File size within limits?
│  │       ├─ CHECK: File path matches data source prefix?
│  │       └─ ACTION: Fix and re-sync
│  │
│  └─ IN COUNT → Continue to Q3
│
└─ Q3: Is the content retrievable?
   │   HOW TO CHECK: Direct Retrieve API query for known content
   │
   ├─ NOT RETRIEVABLE → DIAGNOSIS: Embedding/Chunking Issue
   │       ├─ The document was processed but chunks may not match queries
   │       ├─ ACTION: Review chunking strategy
   │       └─ ACTION: Test with exact phrases from document
   │
   └─ RETRIEVABLE BUT NOT IN RAG RESPONSE →
           └─ See Tree 1 (RAG Quality Issues) Q5-Q6
```

---

## Quick Reference: Common Fixes

| Symptom              | First Thing to Check     | Quick Fix                          |
| -------------------- | ------------------------ | ---------------------------------- |
| Wrong answers        | Retrieved chunks quality | Adjust chunking, embedding model   |
| Slow responses       | Generation time          | Use faster model, enable streaming |
| High costs           | Token usage breakdown    | Implement caching, model tiering   |
| 429 errors           | Request volume           | Add retry with backoff             |
| Content missing      | Sync status              | Re-trigger Knowledge Base sync     |
| Inconsistent results | Temperature setting      | Set temperature=0 for consistency  |
