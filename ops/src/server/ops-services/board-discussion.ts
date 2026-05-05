/**
 * Board discussion engine. Drives a session through the four phases:
 *
 *   A. Opening statements (parallel) — every advisor responds independently
 *      to the topic with the live ops-state context block injected.
 *   B. Crux extraction — chair reads openings and emits a structured list
 *      of disagreements that need resolution.
 *   C. Resolution loop — chair is called repeatedly, each turn picks an
 *      action: exchange, challenge, poll, next_crux, or close. Bounded by
 *      the session's $-cap and a novelty-based drift detector.
 *   D. Final positions (parallel) + chair synthesis. Synthesis lands in
 *      board_decisions with status='proposed'. NO downstream writes here;
 *      that's the review step.
 *
 * Run by /api/ops/board/sessions/:id/run handler. Long-running and
 * fire-and-forget — the route returns 202 and this awaits in the bg.
 */

import {
  type AdvisorWithKnowledge,
  type BoardMessage,
  type BoardSession,
  type ChairAction,
  type ChairSynthesis,
  chairActionSchema,
  chairSynthesisSchema,
  cruxExtractionSchema,
  type FinalPosition,
  finalPositionSchema,
} from '@/lib/board/types';
import { type BoardCallKind, callLlm, KIMI_PRESET, pickModel } from '@/lib/llm';
import {
  addMessage,
  createCrux,
  createDecision,
  getSession,
  incrementSessionSpend,
  listAdvisorsWithKnowledge,
  listCruxes,
  listMessages,
  listPositions,
  updateCrux,
  updateSession,
  upsertPosition,
} from './board';
import { loadContextSnapshot, renderContextBlock } from './board-context';

// ── Posture (shared preamble) ─────────────────────────────────────────

const POSTURE_BLOCK = `**Posture.** You are advising on a vertical SaaS growing toward 10,000 contractor tenants. Reason from that future, not today's customer count. Reject the expedient choice that creates migration pain, trust debt, or a scaling cliff. Reject the paranoid choice that delays a shipment we are confident about. The standard is surefooted speed: move fast on what we are sure of, and name the sources of uncertainty plainly when we are not. If you would give different advice at 30 customers vs. 3,000, say so and recommend the path that does not require a re-do.`;

// ── Bounds ────────────────────────────────────────────────────────────

const MAX_CHAIR_TURNS = 30; // hard ceiling regardless of budget
const MAX_EXCHANGE_TURNS_PER_CRUX = 5;
const NOVELTY_AUTO_CLOSE_THRESHOLD = 2; // 2 chair turns in a row with new_information=false → close
const ADVISOR_OPENING_MAX_TOKENS = 800;
const ADVISOR_EXCHANGE_MAX_TOKENS = 500;
const FINAL_POSITION_MAX_TOKENS = 1200;
const CHAIR_TURN_MAX_TOKENS = 800;
const CHAIR_SYNTHESIS_MAX_TOKENS = 2000;

// ── Public entrypoint ────────────────────────────────────────────────

export async function runDiscussion(session_id: string): Promise<void> {
  const session = await getSession(session_id);
  if (!session) throw new Error(`session ${session_id} not found`);
  if (session.status !== 'pending') {
    throw new Error(`session ${session_id} is ${session.status}, must be pending`);
  }

  await updateSession(session_id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const advisors = await listAdvisorsWithKnowledge(session.advisor_ids);
    const chair = advisors.find((a) => a.role_kind === 'chair');
    if (!chair) throw new Error('no chair advisor in session');
    const panel = advisors.filter((a) => a.role_kind !== 'chair');
    if (panel.length < 2) throw new Error('need at least 2 non-chair advisors');

    // Snapshot live ops state once per session.
    const snapshot = await loadContextSnapshot();
    const contextBlock = renderContextBlock(snapshot);
    await updateSession(session_id, { context_snapshot: snapshot });

    // ─ Phase A: opening statements ─
    await runPhaseA(session, panel, contextBlock);

    // ─ Phase B: crux extraction ─
    const cruxes = await runPhaseB(session, chair, panel);

    // ─ Phase C: resolution loop ─
    await runPhaseC(session, chair, panel, cruxes, contextBlock);

    // ─ Phase D: final positions + synthesis ─
    await runPhaseD(session, chair, panel, contextBlock);

    await updateSession(session_id, {
      status: 'awaiting_review',
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSession(session_id, {
      status: 'failed',
      error_message: message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  }
}

// ── Phase A: openings ────────────────────────────────────────────────

async function runPhaseA(
  session: BoardSession,
  panel: AdvisorWithKnowledge[],
  contextBlock: string,
): Promise<void> {
  await Promise.all(
    panel.map(async (advisor) => {
      if (await sessionOverBudget(session.id)) return;

      const system = buildAdvisorSystem(advisor, contextBlock);
      const user = `## Discussion Topic\n${session.topic}\n\nGive your initial analysis. Be specific, cite reasoning, give actionable advice. End with a clear one-sentence recommendation. 200-400 words.`;

      const choice = pickModel('advisor_opening', overridesFor(session));
      const res = await callLlm(choice, {
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0.7,
        max_tokens: ADVISOR_OPENING_MAX_TOKENS,
      });

      await addMessage({
        session_id: session.id,
        advisor_id: advisor.id,
        crux_id: null,
        turn_kind: 'opening',
        addressed_to: null,
        content: res.text,
        payload: null,
        new_information: null,
        provider: res.provider,
        model: res.model,
        prompt_tokens: res.prompt_tokens,
        completion_tokens: res.completion_tokens,
        cost_cents: res.cost_cents,
        latency_ms: res.latency_ms,
        advisor_rating: null,
        review_note: null,
      });
      await incrementSessionSpend(session.id, res.cost_cents);
    }),
  );
}

// ── Phase B: crux extraction ─────────────────────────────────────────

async function runPhaseB(
  session: BoardSession,
  chair: AdvisorWithKnowledge,
  panel: AdvisorWithKnowledge[],
): Promise<Array<{ id: string; label: string }>> {
  const messages = await listMessages(session.id);
  const openings = messages.filter((m) => m.turn_kind === 'opening');

  const transcript = renderTranscript(openings, panel);
  const advisorIndex = panel.map((a) => `- ${a.id} = ${a.emoji} ${a.name} (${a.title})`).join('\n');

  const system = buildChairSystem(
    chair,
    [
      `You are extracting CRUXES — the specific points where the advisors actually disagree (not just emphasize differently). Output JSON ONLY, matching this schema:`,
      JSON.stringify(
        {
          consensus: ['short string'],
          cruxes: [{ label: 'string', advisors: ['advisor uuid'], summary: 'string' }],
        },
        null,
        2,
      ),
      `Constraints:`,
      `- 0 to 6 cruxes. Don't invent disagreements.`,
      `- 'advisors' must be advisor UUIDs from the index below.`,
      `- 'consensus' = points everyone agreed on (these get noted and skipped).`,
    ].join('\n\n'),
  );

  const user = `## Topic\n${session.topic}\n\n## Advisor index\n${advisorIndex}\n\n## Opening statements\n${transcript}\n\nReturn JSON.`;

  const choice = pickModel('chair_extract_cruxes', overridesFor(session));
  const res = await callLlm(choice, {
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: 1500,
    json: true,
  });
  await incrementSessionSpend(session.id, res.cost_cents);

  const parsed = parseJson(res.text, cruxExtractionSchema, 'crux extraction');

  // Persist cruxes. We persist regardless of whether they map cleanly to
  // advisor IDs; the chair occasionally cites slugs or names instead.
  const created: Array<{ id: string; label: string }> = [];
  for (let i = 0; i < parsed.cruxes.length; i++) {
    const c = parsed.cruxes[i];
    const crux = await createCrux(session.id, c.label, i);
    created.push({ id: crux.id, label: crux.label });
  }

  await addMessage({
    session_id: session.id,
    advisor_id: chair.id,
    crux_id: null,
    turn_kind: 'chair_turn',
    addressed_to: null,
    content: `Identified ${parsed.cruxes.length} crux${parsed.cruxes.length === 1 ? '' : 'es'}: ${parsed.cruxes.map((c) => c.label).join('; ') || '(none)'}\n\nConsensus: ${parsed.consensus.join('; ') || '(none noted)'}`,
    payload: { phase: 'crux_extraction', extraction: parsed },
    new_information: parsed.cruxes.length > 0,
    provider: res.provider,
    model: res.model,
    prompt_tokens: res.prompt_tokens,
    completion_tokens: res.completion_tokens,
    cost_cents: res.cost_cents,
    latency_ms: res.latency_ms,
    advisor_rating: null,
    review_note: null,
  });

  return created;
}

// ── Phase C: resolution loop ─────────────────────────────────────────

async function runPhaseC(
  session: BoardSession,
  chair: AdvisorWithKnowledge,
  panel: AdvisorWithKnowledge[],
  initialCruxes: Array<{ id: string; label: string }>,
  contextBlock: string,
): Promise<void> {
  if (initialCruxes.length === 0) return;

  let consecutiveNoNewInfo = 0;
  const exchangesPerCrux = new Map<string, number>();

  for (let turn = 0; turn < MAX_CHAIR_TURNS; turn++) {
    if (await sessionOverBudget(session.id)) break;

    const cruxes = await listCruxes(session.id);
    const open = cruxes.filter((c) => c.status === 'open');
    if (open.length === 0) break;

    const action = await chairPickAction(session, chair, panel, contextBlock, exchangesPerCrux);

    await addMessage({
      session_id: session.id,
      advisor_id: chair.id,
      crux_id: 'crux_id' in action ? action.crux_id : null,
      turn_kind: 'chair_turn',
      addressed_to: null,
      content: chairActionSummary(action),
      payload: { phase: 'resolution', action },
      new_information: 'new_information' in action ? action.new_information : false,
      provider: null,
      model: null,
      prompt_tokens: null,
      completion_tokens: null,
      cost_cents: null,
      latency_ms: null,
      advisor_rating: null,
      review_note: null,
    });

    if (action.action === 'close') break;

    // Drift detection
    const newInfo = 'new_information' in action ? action.new_information : false;
    if (!newInfo) consecutiveNoNewInfo++;
    else consecutiveNoNewInfo = 0;
    if (consecutiveNoNewInfo >= NOVELTY_AUTO_CLOSE_THRESHOLD) break;

    // Execute the action
    if (action.action === 'exchange') {
      exchangesPerCrux.set(action.crux_id, (exchangesPerCrux.get(action.crux_id) ?? 0) + 1);
      await runExchange(session, panel, action, contextBlock);
    } else if (action.action === 'challenge') {
      exchangesPerCrux.set(action.crux_id, (exchangesPerCrux.get(action.crux_id) ?? 0) + 1);
      await runChallenge(session, panel, action, contextBlock);
    } else if (action.action === 'poll') {
      await runPoll(session, panel, action, contextBlock);
    } else if (action.action === 'next_crux') {
      await updateCrux(action.crux_id, {
        status: action.crux_status,
        resolution_summary: action.resolution_summary,
        closed_at: new Date().toISOString(),
      });
    }
  }

  // Drop any cruxes still open at end of loop.
  const final = await listCruxes(session.id);
  for (const c of final) {
    if (c.status === 'open') {
      await updateCrux(c.id, {
        status: 'dropped',
        resolution_summary: 'Session bounded out before resolution.',
        closed_at: new Date().toISOString(),
      });
    }
  }
}

async function chairPickAction(
  session: BoardSession,
  chair: AdvisorWithKnowledge,
  panel: AdvisorWithKnowledge[],
  contextBlock: string,
  exchangesPerCrux: Map<string, number>,
): Promise<ChairAction> {
  const messages = await listMessages(session.id);
  const cruxes = await listCruxes(session.id);
  const transcript = renderTranscript(messages, panel, chair);

  const open = cruxes.filter((c) => c.status === 'open');
  const closed = cruxes.filter((c) => c.status !== 'open');
  const advisorIndex = panel.map((a) => `- ${a.id} = ${a.emoji} ${a.name} (${a.title})`).join('\n');
  const cruxIndex = open
    .map(
      (c) =>
        `- ${c.id} = ${c.label}${(exchangesPerCrux.get(c.id) ?? 0) >= MAX_EXCHANGE_TURNS_PER_CRUX ? ' [over exchange cap; resolve, deadlock, or drop]' : ''}`,
    )
    .join('\n');
  const closedIndex = closed.map((c) => `- ${c.label} → ${c.status}`).join('\n') || '(none yet)';

  const remaining = Math.max(0, session.budget_cents - session.spent_cents);
  const budgetWarning =
    remaining < session.budget_cents * 0.2
      ? `\n\n⚠️ Budget warning: only ${remaining}¢ remaining of ${session.budget_cents}¢. Start closing cruxes.`
      : '';

  const system = buildChairSystem(
    chair,
    [
      `You are MODERATING a board discussion. Pick ONE action for the next move. Output JSON ONLY, one of these shapes:`,
      `- exchange: { action: 'exchange', crux_id, advisor_a, advisor_b, prompt, reasoning, new_information }`,
      `- challenge: { action: 'challenge', crux_id, challenger_id, target_id, prompt, reasoning, new_information }`,
      `- poll: { action: 'poll', crux_id, question, reasoning, new_information }`,
      `- next_crux: { action: 'next_crux', crux_id, crux_status: 'resolved' | 'deadlock' | 'dropped', resolution_summary, new_information }`,
      `- close: { action: 'close', reasoning }`,
      `\nRules:`,
      `- 'crux_id' must be an open crux UUID from the index.`,
      `- advisor IDs must come from the advisor index.`,
      `- Set new_information=true if your move advances the discussion. Set false if you're repeating ground.`,
      `- Always run at least ONE 'challenge' per crux. Devil's Advocate-style challengers exist for a reason.`,
      `- After 5 exchanges on one crux, resolve, deadlock, or drop it.`,
      `- 'close' only when all cruxes are closed (resolved/deadlock/dropped) or the session is over budget.`,
      `\nAdvisor track records (your prior decisions): use them as signal, not gospel. Past credit doesn't guarantee this answer is right.`,
      contextBlock,
    ].join('\n\n'),
  );

  const user = `## Topic\n${session.topic}\n\n## Advisor index\n${advisorIndex}\n\n## Open cruxes\n${cruxIndex || '(none — close)'}\n\n## Closed cruxes\n${closedIndex}\n\n## Transcript so far\n${transcript || '(empty)'}${budgetWarning}\n\nReturn JSON for your next action.`;

  const choice = pickModel('chair_turn', overridesFor(session));
  const res = await callLlm(choice, {
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0.4,
    max_tokens: CHAIR_TURN_MAX_TOKENS,
    json: true,
  });
  await incrementSessionSpend(session.id, res.cost_cents);

  return parseJson(res.text, chairActionSchema, 'chair action');
}

async function runExchange(
  session: BoardSession,
  panel: AdvisorWithKnowledge[],
  action: Extract<ChairAction, { action: 'exchange' }>,
  contextBlock: string,
): Promise<void> {
  const a = panel.find((x) => x.id === action.advisor_a);
  const b = panel.find((x) => x.id === action.advisor_b);
  if (!a || !b) return;

  // A speaks first
  const aRes = await callAdvisorPrompt(
    session,
    a,
    contextBlock,
    action.prompt,
    'exchange',
    action.crux_id,
    b.id,
  );
  const aMsg = await persistAdvisorMessage(session, a, action.crux_id, 'exchange', b.id, aRes);

  // B responds
  const bPrompt = `${action.prompt}\n\n## ${a.emoji} ${a.name} just said:\n${aMsg.content}\n\nRespond directly. Concede where they're right, push back where they're wrong, build where they're useful.`;
  const bRes = await callAdvisorPrompt(
    session,
    b,
    contextBlock,
    bPrompt,
    'exchange',
    action.crux_id,
    a.id,
  );
  await persistAdvisorMessage(session, b, action.crux_id, 'exchange', a.id, bRes);
}

async function runChallenge(
  session: BoardSession,
  panel: AdvisorWithKnowledge[],
  action: Extract<ChairAction, { action: 'challenge' }>,
  contextBlock: string,
): Promise<void> {
  const challenger = panel.find((x) => x.id === action.challenger_id);
  const target = panel.find((x) => x.id === action.target_id);
  if (!challenger || !target) return;

  const messages = await listMessages(session.id);
  const targetRecent = messages
    .filter((m) => m.advisor_id === target.id)
    .slice(-2)
    .map((m) => m.content)
    .join('\n\n');

  const prompt = `${action.prompt}\n\n## ${target.emoji} ${target.name}'s recent position:\n${targetRecent || '(none yet)'}\n\nChallenge it. Find the weakest claim and push on it. If they're right, say so.`;
  const res = await callAdvisorPrompt(
    session,
    challenger,
    contextBlock,
    prompt,
    'challenge',
    action.crux_id,
    target.id,
  );
  await persistAdvisorMessage(session, challenger, action.crux_id, 'challenge', target.id, res);
}

async function runPoll(
  session: BoardSession,
  panel: AdvisorWithKnowledge[],
  action: Extract<ChairAction, { action: 'poll' }>,
  contextBlock: string,
): Promise<void> {
  await Promise.all(
    panel.map(async (advisor) => {
      if (await sessionOverBudget(session.id)) return;
      const prompt = `## Poll question\n${action.question}\n\nAnswer in 1-3 sentences. State your position clearly.`;
      const res = await callAdvisorPrompt(
        session,
        advisor,
        contextBlock,
        prompt,
        'poll',
        action.crux_id,
        null,
      );
      await persistAdvisorMessage(session, advisor, action.crux_id, 'poll', null, res);
    }),
  );
}

// ── Phase D: final positions + synthesis ─────────────────────────────

async function runPhaseD(
  session: BoardSession,
  chair: AdvisorWithKnowledge,
  panel: AdvisorWithKnowledge[],
  contextBlock: string,
): Promise<void> {
  const cruxes = await listCruxes(session.id);
  const cruxIndex = cruxes.map((c) => `- ${c.id} = ${c.label} [${c.status}]`).join('\n');
  const messages = await listMessages(session.id);
  const transcript = renderTranscript(messages, panel, chair);

  // ─ Final positions, parallel ─
  await Promise.all(
    panel.map(async (advisor) => {
      if (await sessionOverBudget(session.id)) return;
      const ownMessages = messages.filter((m) => m.advisor_id === advisor.id);
      const opening = ownMessages.find((m) => m.turn_kind === 'opening');

      const system = buildAdvisorSystem(advisor, contextBlock);
      const user = `## Discussion Topic\n${session.topic}\n\n## Cruxes\n${cruxIndex || '(none)'}\n\n## Full transcript\n${transcript}\n\n## Your opening statement\n${opening?.content ?? '(missing)'}\n\nProduce your FINAL POSITION as JSON ONLY:\n${JSON.stringify(
        {
          overall: { stance: 'string', confidence: 1, rationale: 'string' },
          cruxes: [{ crux_id: 'uuid', stance: 'string', confidence: 1, rationale: 'string' }],
          shifted_from_opening: ['crux_id where you changed your mind'],
        },
        null,
        2,
      )}`;

      const choice = pickModel('advisor_position', overridesFor(session));
      const res = await callLlm(choice, {
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0.4,
        max_tokens: FINAL_POSITION_MAX_TOKENS,
        json: true,
      });
      await incrementSessionSpend(session.id, res.cost_cents);

      let parsed: FinalPosition | null = null;
      try {
        parsed = parseJson(res.text, finalPositionSchema, 'final position');
      } catch {
        // Fall back to a minimal stub so the chair has something to read
        parsed = {
          overall: { stance: 'unable to parse', confidence: 1, rationale: res.text.slice(0, 1000) },
          cruxes: [],
          shifted_from_opening: [],
        };
      }

      // Persist the message + structured positions
      await addMessage({
        session_id: session.id,
        advisor_id: advisor.id,
        crux_id: null,
        turn_kind: 'final_position',
        addressed_to: null,
        content: renderFinalPositionForTranscript(parsed, cruxes),
        payload: parsed,
        new_information: null,
        provider: res.provider,
        model: res.model,
        prompt_tokens: res.prompt_tokens,
        completion_tokens: res.completion_tokens,
        cost_cents: res.cost_cents,
        latency_ms: res.latency_ms,
        advisor_rating: null,
        review_note: null,
      });

      // Overall row (crux_id = null)
      await upsertPosition({
        session_id: session.id,
        advisor_id: advisor.id,
        crux_id: null,
        stance: parsed.overall.stance,
        confidence: parsed.overall.confidence,
        rationale: parsed.overall.rationale,
        shifted_from_opening: parsed.shifted_from_opening.length > 0,
      });
      // Per-crux rows
      for (const cp of parsed.cruxes) {
        // skip if crux_id isn't real (model hallucinated)
        if (!cruxes.find((c) => c.id === cp.crux_id)) continue;
        await upsertPosition({
          session_id: session.id,
          advisor_id: advisor.id,
          crux_id: cp.crux_id,
          stance: cp.stance,
          confidence: cp.confidence,
          rationale: cp.rationale,
          shifted_from_opening: parsed.shifted_from_opening.includes(cp.crux_id),
        });
      }
    }),
  );

  // ─ Chair synthesis ─
  const positions = await listPositions(session.id);
  const grid = renderPositionGrid(positions, panel, cruxes);

  const system = buildChairSystem(
    chair,
    [
      `You are CLOSING the discussion. Output JSON ONLY:`,
      JSON.stringify(
        {
          decision_text: '1-2 sentences, decisive, no hedging',
          reasoning: '3-6 sentences. Cite specific advisor arguments accepted/rejected.',
          feedback_loop_check:
            'How will we know within N days whether this is working? What is the close-the-loop signal? MANDATORY.',
          action_items: [{ text: 'kanban-ready task', tags: ['optional'] }],
          dissenting_views: 'brief note on counterarguments not adopted, or null',
          chair_overrode_majority: false,
          chair_disagreement_note: 'one paragraph if you overrode the majority, else null',
          credited_advisor_ids: ['advisor uuid'],
          overruled_advisor_ids: ['advisor uuid'],
          overrule_reasons: { advisor_uuid: 'one-line reason' },
        },
        null,
        2,
      ),
      `Rules:`,
      `- credited/overruled MUST be advisor UUIDs from the panel.`,
      `- feedback_loop_check is MANDATORY. The whole point.`,
      `- If you go against the advisor consensus, set chair_overrode_majority=true and write chair_disagreement_note.`,
    ].join('\n\n'),
  );

  const advisorList = panel.map((a) => `- ${a.id} = ${a.emoji} ${a.name} (${a.title})`).join('\n');
  const user = `## Topic\n${session.topic}\n\n## Advisors\n${advisorList}\n\n## Cruxes (resolved/deadlock/dropped)\n${cruxIndex || '(none)'}\n\n## Position grid\n${grid}\n\n## Full transcript\n${transcript}\n\nReturn JSON.`;

  const choice = pickModel('chair_synthesis', overridesFor(session));
  const res = await callLlm(choice, {
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0.4,
    max_tokens: CHAIR_SYNTHESIS_MAX_TOKENS,
    json: true,
  });
  await incrementSessionSpend(session.id, res.cost_cents);

  let synthesis: ChairSynthesis;
  try {
    synthesis = parseJson(res.text, chairSynthesisSchema, 'chair synthesis');
  } catch (err) {
    // Last-ditch fallback: store raw text as decision so the session
    // doesn't fail completely. Review can still rate/edit.
    synthesis = {
      decision_text: 'Synthesis JSON parse failed; raw text in reasoning.',
      reasoning: res.text.slice(0, 4000),
      feedback_loop_check: 'Manual review required.',
      action_items: [],
      dissenting_views: null,
      chair_overrode_majority: false,
      chair_disagreement_note: err instanceof Error ? err.message : null,
      credited_advisor_ids: [],
      overruled_advisor_ids: [],
      overrule_reasons: {},
    };
  }

  // Filter advisor IDs to ones actually in the panel.
  const validIds = new Set(panel.map((a) => a.id));
  synthesis.credited_advisor_ids = synthesis.credited_advisor_ids.filter((id) => validIds.has(id));
  synthesis.overruled_advisor_ids = synthesis.overruled_advisor_ids.filter((id) =>
    validIds.has(id),
  );

  await addMessage({
    session_id: session.id,
    advisor_id: chair.id,
    crux_id: null,
    turn_kind: 'synthesis',
    addressed_to: null,
    content: renderSynthesisForTranscript(synthesis),
    payload: synthesis,
    new_information: true,
    provider: res.provider,
    model: res.model,
    prompt_tokens: res.prompt_tokens,
    completion_tokens: res.completion_tokens,
    cost_cents: res.cost_cents,
    latency_ms: res.latency_ms,
    advisor_rating: null,
    review_note: null,
  });

  await createDecision({
    session_id: session.id,
    decision_text: synthesis.decision_text,
    reasoning: synthesis.reasoning,
    feedback_loop_check: synthesis.feedback_loop_check,
    action_items: synthesis.action_items,
    dissenting_views: synthesis.dissenting_views ?? null,
    chair_overrode_majority: synthesis.chair_overrode_majority,
    chair_disagreement_note: synthesis.chair_disagreement_note ?? null,
    credited_advisor_ids: synthesis.credited_advisor_ids,
    overruled_advisor_ids: synthesis.overruled_advisor_ids,
    overrule_reasons: synthesis.overrule_reasons,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildAdvisorSystem(
  advisor: AdvisorWithKnowledge,
  contextBlock: string,
): Array<{ text: string; cache?: boolean }> {
  return [
    { text: POSTURE_BLOCK },
    {
      text: `## Persona\nYou are ${advisor.emoji} ${advisor.name}, ${advisor.title}.\nExpertise: ${advisor.expertise.join(', ')}\nRole: ${advisor.description}\nRole kind: ${advisor.role_kind}`,
    },
    ...(advisor.knowledge_body
      ? [{ text: `## Skill\n${advisor.knowledge_body}`, cache: true }]
      : []),
    { text: contextBlock, cache: true },
  ];
}

function buildChairSystem(
  chair: AdvisorWithKnowledge,
  instruction: string,
): Array<{ text: string; cache?: boolean }> {
  return [
    { text: POSTURE_BLOCK },
    {
      text: `## Role\nYou are ${chair.emoji} ${chair.name}, ${chair.title}. You hold the reins. Advisors counsel; you decide.`,
    },
    // The Jonathan AI Imprint is the heaviest piece — cache it explicitly.
    ...(chair.knowledge_body
      ? [{ text: `## Operating Imprint\n${chair.knowledge_body}`, cache: true }]
      : []),
    { text: instruction },
  ];
}

async function callAdvisorPrompt(
  session: BoardSession,
  advisor: AdvisorWithKnowledge,
  contextBlock: string,
  userPrompt: string,
  kind: 'exchange' | 'challenge' | 'poll',
  _cruxId: string,
  _addressedTo: string | null,
) {
  const callKind: BoardCallKind =
    kind === 'exchange'
      ? 'advisor_exchange'
      : kind === 'challenge'
        ? 'advisor_challenge'
        : 'advisor_opening';
  const choice = pickModel(callKind, overridesFor(session));
  const res = await callLlm(choice, {
    system: buildAdvisorSystem(advisor, contextBlock),
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    max_tokens: ADVISOR_EXCHANGE_MAX_TOKENS,
  });
  await incrementSessionSpend(session.id, res.cost_cents);
  return res;
}

async function persistAdvisorMessage(
  session: BoardSession,
  advisor: AdvisorWithKnowledge,
  cruxId: string,
  kind: 'exchange' | 'challenge' | 'poll',
  addressedTo: string | null,
  res: {
    text: string;
    provider: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cost_cents: number;
    latency_ms: number;
  },
): Promise<BoardMessage> {
  return await addMessage({
    session_id: session.id,
    advisor_id: advisor.id,
    crux_id: cruxId,
    turn_kind: kind,
    addressed_to: addressedTo,
    content: res.text,
    payload: null,
    new_information: null,
    provider: res.provider,
    model: res.model,
    prompt_tokens: res.prompt_tokens,
    completion_tokens: res.completion_tokens,
    cost_cents: res.cost_cents,
    latency_ms: res.latency_ms,
    advisor_rating: null,
    review_note: null,
  });
}

async function sessionOverBudget(session_id: string): Promise<boolean> {
  const s = await getSession(session_id);
  if (!s) return true;
  return s.spent_cents >= s.budget_cents;
}

function overridesFor(session: BoardSession): { provider?: string | null; model?: string | null } {
  return { provider: session.provider_override, model: session.model_override };
}

function renderTranscript(
  messages: BoardMessage[],
  panel: AdvisorWithKnowledge[],
  chair?: AdvisorWithKnowledge,
): string {
  const byId = new Map<string, AdvisorWithKnowledge>();
  for (const a of panel) byId.set(a.id, a);
  if (chair) byId.set(chair.id, chair);

  return messages
    .map((m) => {
      const a = m.advisor_id ? byId.get(m.advisor_id) : null;
      const who = a ? `${a.emoji} ${a.name}` : '(system)';
      const tag = m.turn_kind === 'opening' ? '' : ` [${m.turn_kind}]`;
      return `### ${who}${tag}\n${m.content}`;
    })
    .join('\n\n---\n\n');
}

function renderPositionGrid(
  positions: Awaited<ReturnType<typeof listPositions>>,
  panel: AdvisorWithKnowledge[],
  cruxes: Awaited<ReturnType<typeof listCruxes>>,
): string {
  const lines: string[] = [];
  for (const a of panel) {
    const overall = positions.find((p) => p.advisor_id === a.id && p.crux_id === null);
    lines.push(`### ${a.emoji} ${a.name}`);
    lines.push(`Overall (conf ${overall?.confidence ?? '?'}): ${overall?.stance ?? '(none)'}`);
    if (overall?.rationale) lines.push(`Rationale: ${overall.rationale}`);
    for (const c of cruxes) {
      const p = positions.find((x) => x.advisor_id === a.id && x.crux_id === c.id);
      if (p)
        lines.push(
          `- [${c.label}] (conf ${p.confidence})${p.shifted_from_opening ? ' (shifted)' : ''}: ${p.stance}`,
        );
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function renderFinalPositionForTranscript(
  p: FinalPosition,
  cruxes: Array<{ id: string; label: string }>,
): string {
  const lines: string[] = [];
  lines.push(`**Overall (conf ${p.overall.confidence}/5):** ${p.overall.stance}`);
  lines.push(`Rationale: ${p.overall.rationale}`);
  if (p.cruxes.length > 0) {
    lines.push('');
    for (const cp of p.cruxes) {
      const c = cruxes.find((x) => x.id === cp.crux_id);
      const label = c?.label ?? cp.crux_id;
      const shifted = p.shifted_from_opening.includes(cp.crux_id) ? ' (shifted)' : '';
      lines.push(`- **${label}** (conf ${cp.confidence}/5)${shifted}: ${cp.stance}`);
    }
  }
  return lines.join('\n');
}

function renderSynthesisForTranscript(s: ChairSynthesis): string {
  const lines = [
    `## Decision`,
    s.decision_text,
    '',
    `## Reasoning`,
    s.reasoning,
    '',
    `## Feedback-Loop Check`,
    s.feedback_loop_check,
    '',
  ];
  if (s.action_items.length > 0) {
    lines.push('## Action Items');
    for (const it of s.action_items) lines.push(`- ${it.text}`);
    lines.push('');
  }
  if (s.dissenting_views) {
    lines.push('## Dissenting Views', s.dissenting_views, '');
  }
  if (s.chair_overrode_majority && s.chair_disagreement_note) {
    lines.push('## Where I Disagree With My Board', s.chair_disagreement_note, '');
  }
  return lines.join('\n').trim();
}

function chairActionSummary(action: ChairAction): string {
  switch (action.action) {
    case 'exchange':
      return `**Exchange** on crux: ${action.prompt}\n\n_Reasoning:_ ${action.reasoning}`;
    case 'challenge':
      return `**Challenge** on crux: ${action.prompt}\n\n_Reasoning:_ ${action.reasoning}`;
    case 'poll':
      return `**Poll**: ${action.question}\n\n_Reasoning:_ ${action.reasoning}`;
    case 'next_crux':
      return `**Closing crux as ${action.crux_status}**: ${action.resolution_summary}`;
    case 'close':
      return `**Closing discussion**: ${action.reasoning}`;
  }
}

/**
 * Find and parse the first JSON object in `text`. Tolerates models that
 * wrap their output in ```json fences or leading prose.
 */
function parseJson<T>(text: string, schema: { parse: (raw: unknown) => T }, label: string): T {
  // Strip code fences
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find first { ... matching close
  const start = s.indexOf('{');
  if (start < 0) throw new Error(`${label}: no JSON object found in:\n${text.slice(0, 500)}`);
  let depth = 0;
  let end = -1;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
  }
  if (end < 0) throw new Error(`${label}: unbalanced JSON in:\n${text.slice(0, 500)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw new Error(`${label}: JSON.parse failed: ${err instanceof Error ? err.message : err}`);
  }
  return schema.parse(raw);
}

// ── Convenience for callers ──────────────────────────────────────────

export const _internalsForTests = {
  POSTURE_BLOCK,
  parseJson,
  KIMI_PRESET,
};
