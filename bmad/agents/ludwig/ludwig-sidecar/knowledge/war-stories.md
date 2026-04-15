# Ludwig's War Stories

_Battle scars from production orchestrations — each one a lesson learned the hard way._

## The God Orchestrator

**What Happened:**
A team built an orchestrator that handled everything — intent classification, state management, error recovery, agent routing, and response generation. "It's simpler to have one component," they said.

**The Disaster:**
2AM pages every week. When one thing broke, everything broke. No isolation, no way to test individual pieces, impossible to debug. The orchestrator had 47 different responsibilities and none of them worked reliably.

**The Lesson:**
Single responsibility isn't just a principle — it's a survival strategy. Each component should have ONE clear owner and ONE clear job. If you can't explain what a component does in one sentence, split it.

**The Fix Pattern:**

```python
# BAD: God Orchestrator
class Orchestrator:
    def handle(self, message):
        intent = self.classify_intent(message)
        state = self.update_state(message)
        errors = self.check_errors()
        agent = self.route_to_agent(intent)
        response = self.generate_response(agent, state)
        # ... 500 more lines

# GOOD: Separated Concerns
class IntentRouter:
    def classify(self, message) -> Intent: ...

class StateManager:
    def update(self, message, intent) -> State: ...

class AgentCoordinator:
    def route(self, intent) -> Agent: ...
```

---

## The Chatty Agents

**What Happened:**
An orchestration had 5 agents that talked to each other constantly. Every turn involved: Orchestrator → Agent A → Orchestrator → Agent B → Orchestrator → Agent C. "Agents should collaborate," they said.

**The Disaster:**
3+ seconds latency per user turn. Context lost in translation between agents. Users complained the system was "thinking too much." By the time the response came, users had given up.

**The Lesson:**
Every handoff is latency and potential context loss. Batch operations when possible. Sometimes a tool is better than an agent. Ask: "Does this really need its own agent, or is it just a function call?"

**The Fix Pattern:**

```typescript
// BAD: Chatty agents
const result = await orchestrator.delegate('profileAgent');
const enriched = await orchestrator.delegate('enrichmentAgent');
const matched = await orchestrator.delegate('matchingAgent');

// GOOD: Batched operation
const result = await orchestrator.parallel([
  profileAgent.extract(doc),
  enrichmentAgent.prepare(context),
]);
const matched = await matchingAgent.process(result);
```

---

## The Missing Timeout

**What Happened:**
An API call to an external job search service had no timeout. "It usually responds in 200ms," they said.

**The Disaster:**
One day the service got slow. Really slow. 10+ minute response times. Users were stuck in loading states with no way out. Sessions hung indefinitely. The UI showed a spinning loader for users who had long since closed the tab.

**The Lesson:**
"Usually" is not a guarantee. Every external call needs a timeout. Every long operation needs an abort signal. Users should always have an escape hatch.

**The Fix Pattern:**

```typescript
// BAD: No timeout
const results = await searchJobs(query);

// GOOD: With timeout and abort
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000);

try {
  const results = await searchJobs(query, { signal: controller.signal });
} catch (e) {
  if (e.name === 'AbortError') {
    return {
      partial: true,
      message: "Search is taking longer than expected. Here's what we found so far...",
    };
  }
  throw e;
} finally {
  clearTimeout(timeoutId);
}
```

---

## The Optimistic State

**What Happened:**
A conversation system assumed state was always valid. "We just set it, why would it be wrong?"

**The Disaster:**
Race conditions. A user sent two messages quickly. The second message processed with stale state from before the first message completed. Entity references pointed to nothing. Artifacts disappeared. Users saw "that issue you mentioned" when they hadn't mentioned any issue.

**The Lesson:**
State can corrupt. Messages arrive out of order. Operations fail halfway. Always validate state before use. Add checksums, version numbers, or timestamps.

**The Fix Pattern:**

```python
# BAD: Optimistic state
artifact = state.artifacts[artifact_id]
process(artifact)

# GOOD: Defensive state
artifact = state.artifacts.get(artifact_id)
if not artifact:
    return await request_clarification(
        "I lost track of which item you meant. Could you specify?"
    )
if artifact.version != expected_version:
    return await handle_stale_reference(artifact)
process(artifact)
```

---

## The Context Explosion

**What Happened:**
A chat system passed the full conversation history on every turn. "We need all the context for good responses," they said.

**The Disaster:**
Around turn 15, responses started degrading. By turn 25, the model was confused and repetitive. Turn 40? Out of memory errors. The token budget was blown and nobody noticed until users reported "the AI got dumb."

**The Lesson:**
Context windows are finite. History must be managed. Summarize old turns, keep recent ones verbatim, and always track your token budget.

**The Fix Pattern:**

```typescript
function manageHistory(messages: Message[], maxTokens: number): Message[] {
  const tokenCount = countTokens(messages);

  if (tokenCount <= maxTokens) return messages;

  // Keep first (context) and last 5 (recent)
  const essential = [messages[0], ...messages.slice(-5)];
  const middle = messages.slice(1, -5);

  // Summarize the middle
  const summary = await summarize(middle);

  return [
    messages[0],
    { role: 'system', content: `[Earlier conversation summary: ${summary}]` },
    ...messages.slice(-5),
  ];
}
```

---

## The Infinite Self-Correction Loop

**What Happened:**
A code synthesis agent had a self-correction engine that retried up to 5 times on error. "It'll fix itself," they said.

**The Disaster:**
The error classifier kept saying "transient error, retry" because each retry generated DIFFERENT code that failed in DIFFERENT ways. The system burned through 5 retries generating 5 different wrong answers. Users waited 30+ seconds for garbage.

**The Lesson:**
Self-correction needs stability detection. If the error signature changes between retries, something is fundamentally wrong. Stop retrying and escalate.

**The Fix Pattern:**

```python
async def self_correct(func, max_attempts=5):
    previous_error = None
    instability_count = 0

    for attempt in range(max_attempts):
        try:
            return await func()
        except TransientError as e:
            current_signature = hash_error(e)

            if previous_error and current_signature != previous_error:
                instability_count += 1
                if instability_count >= 2:
                    raise EscalateToUser(
                        "Error pattern is unstable. Needs human review.",
                        attempts=attempt + 1
                    )

            previous_error = current_signature
            await apply_fix(e)

    raise MaxRetriesExceeded()
```

---

_More war stories are added as Ludwig encounters new battles._
