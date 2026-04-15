# Ludwig's Anti-Pattern Catalog

_Failure modes to avoid — I've seen these destroy orchestrations._

## Architecture Anti-Patterns

### 🔴 The God Orchestrator

**What It Looks Like:**

- One component handling 5+ distinct responsibilities
- Single file with 1000+ lines
- "It's simpler this way" justification

**Warning Signs:**

- You can't explain what it does in one sentence
- Changes in one area break unrelated functionality
- Testing requires setting up the entire system

**Why It Fails:**

- No isolation — one bug brings down everything
- Impossible to test individual pieces
- Cognitive overload for developers
- Can't scale or evolve parts independently

**The Fix:**
Split by responsibility. Each component should have ONE clear owner and ONE clear job.

---

### 🔴 The Chatty Agents

**What It Looks Like:**

- 5+ handoffs per user turn
- Agents calling orchestrator calling agents
- "Agents should collaborate" mindset

**Warning Signs:**

- Latency > 2 seconds per turn
- Context getting lost between handoffs
- Users complaining system is "slow" or "confused"

**Why It Fails:**

- Every handoff adds latency (100-500ms each)
- Context degrades with each transfer
- Communication overhead exceeds value

**The Fix:**
Batch operations. Sometimes a tool is better than an agent. Ask: "Does this need its own agent, or is it a function call?"

---

### 🔴 The Premature Multi-Agent

**What It Looks Like:**

- 3+ specialized agents for a simple task
- Agents with 1-2 responsibilities each
- "Multi-agent is the future" justification

**Warning Signs:**

- You could replace an agent with a function
- Agents exist for "cleanliness" not necessity
- Total system complexity exceeds problem complexity

**Why It Fails:**

- Over-engineering adds maintenance burden
- More moving parts = more failure points
- Coordination overhead dominates execution time

**The Fix:**
Start with ONE agent and tools. Add agents only when you can't solve the problem with tools. Each agent should earn its existence.

---

## State Anti-Patterns

### 🔴 The Optimistic State

**What It Looks Like:**

- `state.artifacts[id]` with no null check
- Assuming state is always current
- No version tracking

**Warning Signs:**

- "Undefined is not an object" errors
- Race condition bugs
- Entity references pointing to nothing

**Why It Fails:**

- State CAN corrupt (network issues, race conditions, partial failures)
- Messages arrive out of order
- Operations fail halfway

**The Fix:**
Defensive state access. Validate before use. Add version numbers or timestamps. Handle the "entity doesn't exist" case gracefully.

```typescript
// BAD
const artifact = state.artifacts[id];
process(artifact);

// GOOD
const artifact = state.artifacts.get(id);
if (!artifact) {
  return requestClarification('Which item did you mean?');
}
```

---

### 🔴 The Context Explosion

**What It Looks Like:**

- Passing full conversation history every turn
- No summarization or compression
- "We need all the context" justification

**Warning Signs:**

- Response quality degrades after turn 15
- Model becomes repetitive or confused
- OOM errors in long sessions

**Why It Fails:**

- Context windows are finite
- LLMs attend less to middle content
- Token costs explode

**The Fix:**
History management. Summarize old turns, keep recent verbatim, track token budget.

---

### 🔴 The Stateless Illusion

**What It Looks Like:**

- Treating each turn as independent
- No entity tracking across turns
- No artifact persistence

**Warning Signs:**

- User says "that issue" and system doesn't know what they mean
- Have to re-specify context every turn
- No conversational continuity

**Why It Fails:**

- Conversations are inherently stateful
- Users expect context to carry over
- Repeated clarification requests frustrate users

**The Fix:**
Explicit state management. Track entities, artifacts, and conversation context. Resolve references across turns.

---

## Error Handling Anti-Patterns

### 🔴 The Silent Failure

**What It Looks Like:**

- `try { ... } catch { /* ignore */ }`
- Errors logged but not handled
- User sees stale or partial data

**Warning Signs:**

- Things "just don't work" without errors
- Users report "nothing happened"
- Logs show errors users never saw

**Why It Fails:**

- Users don't know something went wrong
- Silent failures compound over time
- Impossible to debug

**The Fix:**
Every error needs a user-visible outcome. Even if it's "Something went wrong, please try again."

---

### 🔴 The Infinite Retry

**What It Looks Like:**

- Retry loops without limits
- No backoff strategy
- No error classification

**Warning Signs:**

- System hammering a failing service
- Users waiting indefinitely
- Resource exhaustion

**Why It Fails:**

- Transient errors might not be transient
- Without backoff, you DOS the service
- Without limits, users wait forever

**The Fix:**
Limited retries with exponential backoff. Classify errors: transient (retry), permanent (fail), user (clarify).

```typescript
// BAD
while (true) {
  try {
    return await fetch();
  } catch {
    continue;
  }
}

// GOOD
for (let i = 0; i < 3; i++) {
  try {
    return await fetch();
  } catch (e) {
    if (isPermanent(e)) throw e;
    await sleep(Math.pow(2, i) * 1000);
  }
}
throw new MaxRetriesError();
```

---

### 🔴 The Missing Timeout

**What It Looks Like:**

- External calls with no timeout
- "It usually responds quickly" justification
- No abort controller

**Warning Signs:**

- Users stuck in loading states
- Sessions that never complete
- "The system hung" reports

**Why It Fails:**

- "Usually" is not a guarantee
- External services can slow down or hang
- Users have no escape hatch

**The Fix:**
Every external call gets a timeout. Every long operation gets an abort signal.

---

## UX Anti-Patterns

### 🔴 The Exposed Machinery

**What It Looks Like:**

- Showing internal scores to users
- Technical error messages
- "Processing step 3 of 7..."

**Warning Signs:**

- Users asking "what does this number mean?"
- Confusion about internal state
- Breaking conversational immersion

**Why It Fails:**

- Users don't need to see the machinery
- Technical details confuse rather than help
- Breaks the illusion of natural conversation

**The Fix:**
Invisible reasoning. Internal state stays internal. User sees natural conversation, not scores and steps.

---

### 🔴 The Free Text Trap

**What It Looks Like:**

- Asking "Which project?" as free text
- No validation on user input
- Hope-based parsing

**Warning Signs:**

- Users typing invalid values
- Clarification loops
- "I don't understand" responses

**Why It Fails:**

- Free text is ambiguous
- Users don't know valid options
- Parsing is error-prone

**The Fix:**
Structured clarification. Dropdowns with real options. Fetch valid values and present them.

```typescript
// BAD
'Which project should I use?';

// GOOD
const projects = await fetchUserProjects();
presentDropdown('Select a project:', projects);
```

---

_More anti-patterns are added as Ludwig encounters new failures._
