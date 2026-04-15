# Ludwig's Pattern Catalog

_Proven orchestration patterns — use these, they work._

## Orchestration Patterns

### 1. Orchestrator-Worker

**Use When:** Multiple specialized domains, complex task decomposition

**Structure:**

```
     ┌─────────────────┐
     │   Orchestrator  │
     │  (coordinates)  │
     └────────┬────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐
│Worker │ │Worker │ │Worker │
│   A   │ │   B   │ │   C   │
└───────┘ └───────┘ └───────┘
```

**Code Pattern (TypeScript):**

```typescript
const orchestrator = new ToolLoopAgent({
  model: openai('gpt-4o'),
  system: `You coordinate specialist agents. Analyze the request and delegate to the appropriate specialist.`,
  tools: {
    delegateToProfile: tool({
      description: 'Delegate profile-related tasks',
      parameters: z.object({ task: z.string() }),
      execute: async ({ task }) => profileAgent.process(task)
    }),
    delegateToMatching: tool({
      description: 'Delegate job matching tasks',
      parameters: z.object({ criteria: z.object({...}) }),
      execute: async ({ criteria }) => matchingAgent.search(criteria)
    })
  }
});
```

---

### 2. Sequential Chain

**Use When:** Strict ordering required, each step depends on previous

**Structure:**

```
┌───────┐    ┌───────┐    ┌───────┐    ┌───────┐
│ Step  │───▶│ Step  │───▶│ Step  │───▶│ Step  │
│   1   │    │   2   │    │   3   │    │   4   │
└───────┘    └───────┘    └───────┘    └───────┘
     │            │            │
     ▼            ▼            ▼
  [checkpoint] [checkpoint] [checkpoint]
```

**Code Pattern (Python/LangGraph):**

```python
from langgraph.graph import StateGraph

graph = StateGraph(PipelineState)

graph.add_node("extract", extract_node)
graph.add_node("validate", validate_node)
graph.add_node("enrich", enrich_node)
graph.add_node("output", output_node)

graph.add_edge("extract", "validate")
graph.add_edge("validate", "enrich")
graph.add_edge("enrich", "output")

graph.set_entry_point("extract")
app = graph.compile(checkpointer=SqliteSaver())
```

---

### 3. Parallel Fan-Out/Fan-In

**Use When:** Independent tasks that can run concurrently

**Structure:**

```
              ┌───────┐
              │ Start │
              └───┬───┘
        ┌─────────┼─────────┐
        ▼         ▼         ▼
    ┌───────┐ ┌───────┐ ┌───────┐
    │Task A │ │Task B │ │Task C │
    └───┬───┘ └───┬───┘ └───┬───┘
        └─────────┼─────────┘
              ┌───▼───┐
              │Combine│
              └───────┘
```

**Code Pattern (TypeScript):**

```typescript
async function parallelProcess(input: Input): Promise<CombinedResult> {
  const [profileData, jobListings, marketData] = await Promise.all([
    profileAgent.extract(input.resume),
    jobSearchAgent.search(input.criteria),
    marketAgent.analyze(input.industry),
  ]);

  return combineResults(profileData, jobListings, marketData);
}
```

---

### 4. Router Pattern

**Use When:** Different paths based on input classification

**Structure:**

```
              ┌───────┐
              │ Input │
              └───┬───┘
                  ▼
           ┌──────────┐
           │ Classify │
           └────┬─────┘
        ┌───────┼───────┐
        ▼       ▼       ▼
    ┌──────┐┌──────┐┌──────┐
    │Path A││Path B││Path C│
    └──────┘└──────┘└──────┘
```

**Code Pattern:**

```typescript
const router = tool({
  description: 'Route request to appropriate handler',
  parameters: z.object({
    intent: z.enum(['create', 'query', 'update', 'delete']),
    resource: z.string(),
  }),
  execute: async ({ intent, resource }) => {
    const handlers = {
      create: createHandler,
      query: queryHandler,
      update: updateHandler,
      delete: deleteHandler,
    };
    return handlers[intent](resource);
  },
});
```

---

### 5. Evaluator-Optimizer Loop

**Use When:** Quality gates, iterative improvement

**Structure:**

```
┌─────────┐     ┌──────────┐     ┌─────────┐
│ Generate│────▶│ Evaluate │────▶│ Good?   │
└─────────┘     └──────────┘     └────┬────┘
      ▲                               │
      │         ┌──────────┐     No   │ Yes
      └─────────│  Revise  │◀─────────┤
                └──────────┘          ▼
                                 ┌─────────┐
                                 │ Output  │
                                 └─────────┘
```

**Code Pattern:**

```python
async def generate_with_evaluation(task: str, max_iterations: int = 3) -> str:
    output = await generate(task)

    for _ in range(max_iterations):
        evaluation = await evaluate(output, task)

        if evaluation.score >= 8:
            return output

        output = await revise(output, evaluation.feedback)

    return output  # Best effort after max iterations
```

---

## State Management Patterns

### Entity Resolution Pattern

**Problem:** User says "it" or "that issue" — what do they mean?

**Solution:**

```typescript
interface ConversationState {
  entities: Map<string, EntityRef>;
  lastMentioned: {
    issue?: string;
    project?: string;
    user?: string;
  };
}

function resolveReference(ref: string, state: ConversationState): EntityRef | null {
  // Direct reference
  if (state.entities.has(ref)) {
    return state.entities.get(ref);
  }

  // Pronoun resolution
  if (['it', 'that', 'this'].includes(ref.toLowerCase())) {
    return state.entities.get(state.lastMentioned.issue);
  }

  // Fuzzy match
  return findClosestMatch(ref, state.entities);
}
```

---

### History Compression Pattern

**Problem:** Context window overflow after many turns

**Solution:**

```typescript
function compressHistory(messages: Message[], budget: number): Message[] {
  // Priority 1: Always keep system prompt
  // Priority 2: Always keep last 3 turns
  // Priority 3: Keep messages with tool results
  // Priority 4: Keep user confirmations
  // Summarize everything else

  const essential = extractEssential(messages);
  const summarizable = messages.filter((m) => !essential.includes(m));

  if (countTokens(essential) > budget) {
    throw new Error('Essential messages exceed budget');
  }

  const remainingBudget = budget - countTokens(essential);
  const summary = summarizeToFit(summarizable, remainingBudget);

  return [
    messages[0], // System
    { role: 'system', content: `[Earlier: ${summary}]` },
    ...messages.slice(-3), // Recent
  ];
}
```

---

## Error Handling Patterns

### Circuit Breaker Pattern

**Problem:** External service is failing repeatedly

**Solution:**

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure?: Date;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private timeout: number = 30000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure!.getTime() > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new CircuitOpenError();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = new Date();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}
```

---

_More patterns are added as Ludwig discovers effective techniques._
