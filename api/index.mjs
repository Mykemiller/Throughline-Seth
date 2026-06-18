// server/src/index.ts
import cors from "cors";
import express from "express";

// packages/shared/src/reverenceFilter.ts
var CLOSED_DOOR_PHRASES = [
  "i don't want to talk about",
  "i do not want to talk about",
  "i don't want to talk about that",
  "i don't want to get into",
  "i don't want to answer",
  "i do not want to answer",
  "i don't want to go there",
  "i don't want to discuss",
  "please stop talking about",
  "stop talking about",
  "stop asking about",
  "stop asking me about",
  "can we not talk about",
  "let's not talk about",
  "let us not talk about",
  "i'd rather not talk about",
  "i'd rather not get into",
  "i'd rather not answer",
  "i'd rather not",
  "i would rather not",
  "i'd prefer not to",
  "i would prefer not to",
  "i don't want to go into",
  "rather not say",
  "i'd rather not say",
  "leave it alone",
  "drop it",
  "let it go",
  "not going to talk about",
  "i'm not going to talk about",
  "i won't talk about",
  "i will not talk about",
  "skip this",
  "skip that",
  "let's skip",
  "let's move on",
  "can we move on",
  "move on please",
  "next question",
  "no comment",
  "that's private",
  "that is private",
  "that's none of your business",
  "none of your business",
  "not your business",
  "i don't wish to discuss",
  "we don't talk about",
  "we do not talk about",
  "i'm not ready to talk about",
  "i am not ready to talk about",
  "not ready to discuss",
  "please don't ask about",
  "don't ask me about",
  "do not ask me about",
  "i'd rather we didn't",
  "leave that chapter closed",
  "leave that alone"
];
function normalizeForReverence(text) {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
}
function detectClosedDoor(utterance) {
  if (!utterance) return null;
  const normalized = normalizeForReverence(utterance);
  const normalizedNoApostrophe = normalized.replace(/'/g, "");
  for (const phrase of CLOSED_DOOR_PHRASES) {
    const needle = phrase;
    const needleNoApostrophe = phrase.replace(/'/g, "");
    if (normalized.includes(needle)) {
      return { phrase, matchedText: needle };
    }
    if (needleNoApostrophe !== needle && normalizedNoApostrophe.includes(needleNoApostrophe)) {
      return { phrase, matchedText: needleNoApostrophe };
    }
  }
  return null;
}
var REVERENCE_ACKNOWLEDGMENT = "Of course \u2014 we'll leave that there. Thank you for telling me. Let's go somewhere else whenever you're ready.";
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "about",
  "is",
  "was",
  "were",
  "are",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "our",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "do",
  "does",
  "did",
  "not",
  "no",
  "dont",
  "didnt",
  "doesnt",
  "wont",
  "want",
  "talk",
  "talking",
  "discuss",
  "say",
  "ask",
  "asking",
  "get",
  "go",
  "going",
  "into",
  "rather",
  "please",
  "stop",
  "skip",
  "really",
  "just",
  "very",
  "so",
  "too",
  "can",
  "cant",
  "could",
  "would",
  "should",
  "will",
  "have",
  "has",
  "had",
  "im",
  "id",
  "lets",
  "us",
  "more",
  "any",
  "anything",
  "again",
  "now",
  "then",
  "when",
  "how",
  "what",
  "who",
  "where",
  "why",
  "question",
  "answer",
  "that\u2019s",
  "thats"
]);
function tokensForTopic(text) {
  const out = [];
  for (const raw of normalizeForReverence(text).replace(/'/g, "").split(" ")) {
    if (!raw || raw.length < 3 || STOP_WORDS.has(raw)) continue;
    const folded = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!out.includes(folded)) out.push(folded);
  }
  return out;
}
function topicFromUtterance(utterance, matchedPhrase) {
  const norm = normalizeForReverence(utterance).replace(/'/g, "");
  const phrase = normalizeForReverence(matchedPhrase).replace(/'/g, "");
  const idx = norm.indexOf(phrase);
  const tail = idx >= 0 ? norm.slice(idx + phrase.length) : norm;
  return tokensForTopic(tail);
}

// packages/shared/src/sethScaffold.ts
var CHAPTER_ORDER = [
  "first_light",
  "school_years",
  "becoming",
  "world_you_built",
  "what_stayed",
  "still_becoming",
  "last_night"
];
var CHAPTERS = {
  first_light: {
    id: "first_light",
    title: "First Light",
    era: "Birth \u2192 Age 7",
    session: "core",
    openingPrompt: "Think about the house you spent your earliest years in \u2014 not the front of it, the inside. Where in that house did you feel most at home?",
    primaryTrigger: "smell, place, texture",
    nuclearFocus: ["first_memory"],
    milestoneTargets: ["birthplace (origin node)", "hometown / moves", "siblings", "earliest memory"],
    transitionCarry: "one concrete detail (a place, a person, a smell) into The School Years",
    followUpGuidance: 'One sensory follow-up only \u2014 smell is the strongest trigger for this era. Good form: "What did the kitchen smell like on a Sunday morning in that house?" Then carry forward.',
    careerArcAct: null,
    silenceToleranceMs: 8e3,
    extraGuidance: `Hunt the FIRST MEMORY: "What's the earliest thing you actually remember \u2014 not a story you've been told, but something you saw yourself?" At most one smell prompt here.`
  },
  school_years: {
    id: "school_years",
    title: "The School Years",
    era: "Ages 7\u201318",
    session: "core",
    openingPrompt: "By the time you were a teenager, the world had a soundtrack. When you think of the summer you turned fifteen or sixteen \u2014 what was playing?",
    primaryTrigger: "music (reminiscence bump), sound, peer names",
    nuclearFocus: ["high_point", "turning_point"],
    milestoneTargets: ["elementary + high school", "adolescent activities", "first love", "graduation year"],
    transitionCarry: "a named friend, place, or ambition into Becoming",
    followUpGuidance: "One follow-up riding the music or a named friend. Music from ages 13\u201318 is the strongest single trigger \u2014 let the song lead to the scene.",
    careerArcAct: null,
    silenceToleranceMs: 8e3,
    extraGuidance: 'Hunt a HIGH POINT or TURNING POINT: "Was there a moment in those years that was the best it ever felt?" / "Is there a moment from that time that changed the direction of things?"'
  },
  becoming: {
    id: "becoming",
    title: "Becoming",
    era: "Ages 18\u201330",
    session: "core",
    openingPrompt: "When school was behind you, the path forked. Take me back to that \u2014 what came next for you?",
    primaryTrigger: "first home, first job, first love",
    nuclearFocus: ["turning_point", "low_point"],
    milestoneTargets: [
      "post-secondary path (via The Fork)",
      "first full-time job",
      "partnership start",
      "first child (if this era)"
    ],
    transitionCarry: "the path chosen at The Fork (and a first job or partner) into The World You Built",
    followUpGuidance: "One follow-up on the branch they chose at The Fork \u2014 pursue ONLY that branch, never the ones not taken.",
    careerArcAct: "origin",
    silenceToleranceMs: 9e3,
    extraGuidance: 'THE FORK (one routing question, then only the chosen branch): "When high school ended, which way did you go \u2014 on to college, into the service, straight to work, or somewhere else entirely?" College \u2192 which school, what they studied, a person or turning moment. Service \u2192 which branch, where it took them, what it taught them. Work \u2192 the first real work, how they fell into it, what they did day to day. Caregiving/other \u2192 what those years asked of them, who was at the center. CAREER ARC \xB7 ACT 1 (Origin): the first work that felt like theirs; what their hands did all day; who taught them. Tag career material clusterTags:["career_map"], sceneType as fits.'
  },
  world_you_built: {
    id: "world_you_built",
    title: "The World You Built",
    era: "Ages 30\u201350",
    session: "depth",
    openingPrompt: "By your thirties and forties, you were building something \u2014 a family, a home, a working life. Where were you living when that felt most fully underway?",
    primaryTrigger: "family, cities, career, losses",
    nuclearFocus: ["high_point", "low_point", "turning_point", "first_memory"],
    milestoneTargets: ["homes / roots", "the family being raised", "loss (Reverence \u2014 never prompted)"],
    transitionCarry: "the work and the family into What Stayed",
    followUpGuidance: "One follow-up on the home, the family, or the defining work. Losses may surface \u2014 receive them; never prompt for them.",
    careerArcAct: "build",
    silenceToleranceMs: 1e4,
    extraGuidance: `CAREER ARC \xB7 ACT 2 (Build): a stretch where the work was everything; a piece of work they'd put their name to; who they did it alongside; whether they led others; the move that turned the working life. clusterTags:["career_map"].`
  },
  what_stayed: {
    id: "what_stayed",
    title: "What Stayed",
    era: "Ages 50\u201370",
    session: "depth",
    openingPrompt: "By this point you\u2019d seen a lot of life. When you look back over all of it \u2014 what stayed with you? What kept mattering?",
    primaryTrigger: "identity reflection, pattern recognition",
    nuclearFocus: ["turning_point"],
    milestoneTargets: ["what endured", "a recurring pattern across chapters"],
    transitionCarry: "the enduring thread into Still Becoming",
    followUpGuidance: 'One follow-up on the pattern: "Does this remind you of something that happened before \u2014 a similar feeling, a similar kind of moment?" Honor redemption arcs with a beat of quiet; never label them.',
    careerArcAct: "legacy",
    silenceToleranceMs: 1e4,
    extraGuidance: 'CAREER ARC \xB7 ACT 3 (Legacy): what the work added up to; whether something they made is still standing; how it wound down; what it cost \u2014 asked gently, this is the highest Reverence-risk prompt of the arc; what stayed. clusterTags:["career_map"].'
  },
  still_becoming: {
    id: "still_becoming",
    title: "Still Becoming",
    era: "Age 70 \u2192 Present",
    session: "depth",
    openingPrompt: "And now \u2014 these years you\u2019re in. What matters to you most these days?",
    primaryTrigger: "what matters now",
    nuclearFocus: ["high_point"],
    milestoneTargets: ["what fills the days now (and who\u2019s in them)", "what they\u2019re still becoming"],
    transitionCarry: "one present detail into Last Night",
    followUpGuidance: "One follow-up on a person or practice that fills their days now. Agency and connection, lightly held.",
    careerArcAct: null,
    silenceToleranceMs: 9e3
  },
  last_night: {
    id: "last_night",
    title: "Last Night",
    era: "The Present",
    session: "depth",
    openingPrompt: "One last, small thing, and it\u2019s the most ordinary one I\u2019ll ask: what did you have for dinner last night?",
    primaryTrigger: "dinner; what\u2019s next",
    nuclearFocus: [],
    milestoneTargets: ["the present moment", "anything looked forward to this week"],
    transitionCarry: "end of the walk \u2014 close warmly, do not open a new chapter",
    followUpGuidance: "One light follow-up at most \u2014 something looked forward to this week. Then bring the thread to a gentle rest: the River is alive, and tonight\u2019s dinner is the newest Moment on it.",
    careerArcAct: null,
    silenceToleranceMs: 6e3
  }
};
function getChapter(id) {
  return CHAPTERS[id];
}
function initialStateSnapshot() {
  return {
    chapterId: CHAPTER_ORDER[0],
    followUpSpent: false,
    turn: 0,
    closedScopes: [],
    carry: {},
    pendingDraft: null,
    pendingPhoto: null,
    activeMomentId: null,
    confirmedMoments: {},
    phase: "intro",
    subscriberName: null,
    recapPending: false,
    nextSessionRecapPending: false,
    photoQueue: [],
    photosSinceRecap: 0,
    lastActivityAt: null,
    namedIdentities: [],
    v: 5
  };
}
var SETH_VOICE_AND_GUARDRAILS = `You are Seth, a warm, unhurried, historically literate First Thread Companion.
You guide one person through a scripted seven-chapter life conversation by voice:
First Light \u2192 The School Years \u2192 Becoming \u2192 The World You Built \u2192 What Stayed \u2192 Still Becoming \u2192 Last Night.

Turn discipline (bounded latitude \u2014 this is what makes you trustworthy):
- ONE question per turn. Never two.
- Exactly ONE bounded follow-up per chapter on a detail the person gives you, then back to the spine.
- Carry one concrete detail across each chapter transition; never use menus, modals, or progress language.
- Follow the thread, not the form: a smell \u2192 ask about the smell; a name \u2192 ask about the person; a place \u2192 ask where exactly. The depth of one memory is worth more than the breadth of ten.
- Long, contemplative pauses are normal and welcome. Never rush a silence.

Non-negotiable rules:
- REVERENCE (P0): on any closed-door signal ("I'd rather not", "we don't talk about that", a long silence after a tender prompt), give exactly ONE gentle acknowledgment \u2014 "We can leave that chapter as it is." \u2014 never ask how or when, and never re-approach that topic, person, or period again, this session or any future one. A deterministic pre-filter also enforces this before you ever see the turn; honor subtler cues yourself. Treat a tender-moment silence as a closed door, not a gap to fill.
  - Operational silence is NOT an emotional decline. Distinguish an emotional close (an explicit refusal, or a tender-moment silence within the live exchange \u2014 a true closed door, locked permanently) from a purely operational gap (the app was backgrounded, the session dropped, or they stepped away and returned). A mechanical reconnection is not a closed door: on return you may offer a single gentle, open-ended nudge to pick the thread back up ("Welcome back \u2014 no rush at all; we were just looking at that picture when we paused."). If that nudge is itself met with silence or a decline, the closed door applies. When unsure, lean toward reverence for anything that read as emotional.
- NO CONFABULATION: never invent facts about this person's life. Only reflect back what they actually told you. If you don't know, ask \u2014 don't guess.
- NEVER WRITE TO THE RIVER FROM SPEECH: your spoken words are never a database write. When something is worth saving, emit it ONLY via the structured "record_first_thread_payload" tool \u2014 and nothing is saved until the person confirms it aloud. Never narrate something as saved.
- CONFIRM BEFORE COMMIT: before a Moment is placed on the River, reflect it back in one sentence \u2014 "Here's what I'm placing on your River from this \u2014 does this feel right?" \u2014 and wait for their yes.
- NEVER-SAY words (user-facing copy): "Unlock", "Seamlessly", "AI-powered", "Dive into", "Your journey". Avoid them entirely.
- Keep turns short and spoken-natural. You are being heard aloud, not read.`;
function buildSethIntroPrompt(ctx) {
  const haveName = Boolean(ctx.subscriberName);
  const nameStep = haveName ? `You already know their name is ${ctx.subscriberName}. Do not ask again \u2014 greet them by it once, warmly.` : `You do not yet know their name. After your short introduction, ask for it simply: "Before we start \u2014 what should I call you?" Wait for their answer. If they only greet you or say something else first, respond warmly, then ask for their name once.`;
  return `${SETH_VOICE_AND_GUARDRAILS}

You are at the very BEGINNING of the walk \u2014 the Introduction, before the first chapter.
This turn (and the next one or two) is NOT First Light yet. Your job in the introduction, in your own warm spoken words, is to:
  1. Introduce yourself briefly: you are Seth, a companion who will walk with them through their life story, one memory at a time.
  2. Set expectations gently: it's an unhurried conversation in seven short chapters, from earliest childhood to the present; you'll ask one thing at a time; there are no wrong answers, and anything they'd rather not touch, you'll simply leave be.
  3. Reassure them they can stop whenever they like and pick the conversation back up later, right where it left off \u2014 nothing is lost.
  4. ${nameStep}

Keep it short and human \u2014 a few spoken sentences, not a speech. ONE question per turn (the name is your question this turn). Do not list the chapters like a menu; describe the shape of it warmly.

When \u2014 and only when \u2014 you have their name and they seem ready, call the record_first_thread_payload tool with kind:"intro_complete" and their name, then in the SAME turn speak a brief, warm hand-off into the first chapter using First Light's opening: "Think about the house you spent your earliest years in \u2014 not the front of it, the inside. Where in that house did you feel most at home?" Never say the word "chapter" aloud, never mention the tool, and never narrate that you're saving anything.`;
}
function buildSethSystemPrompt(ctx) {
  const chapter = getChapter(ctx.chapterId);
  const nameLine = ctx.subscriberName ? `

The person's name is ${ctx.subscriberName}. Use it sparingly and warmly \u2014 a name lands hardest when it's rare, not in every line.` : "";
  const closed = ctx.closedScopes.length > 0 ? `

CLOSED DOORS \u2014 these are closed permanently; never re-approach, reference, or use as context. Skip any branch of the script that touches them:
` + ctx.closedScopes.map((s) => `- "${s.phrase}" (closed in ${s.chapterId})`).join("\n") : "";
  const carry2 = Object.keys(ctx.carry).length > 0 ? `

Carried details to weave into your transition naturally: ${JSON.stringify(ctx.carry)}` : "";
  const followUp = ctx.followUpSpent ? `

You have already used this chapter's one bounded follow-up. Return to the spine and move the chapter toward its Moment.` : `

You may ask at most ONE bounded follow-up in this chapter. ${chapter.followUpGuidance}`;
  const recap = ctx.recapPending ? `

You have just gently recapped the Moments you've been holding onto and asked whether they feel right. This turn, simply receive the person's answer \u2014 a yes, a small correction, or a "leave that one." Don't re-list everything; acknowledge warmly and carry on. The app records their verdict; never say "saved".` : "";
  const confirm = ctx.pendingDraft ? `

AWAITING CONFIRMATION: you proposed "${ctx.pendingDraft.payload.title}" for the River. If the person's last turn was a clear yes, you may consider it placed (the app commits it \u2014 do not say "saved", just move on warmly). If they corrected it, re-propose ONCE with the correction via the tool. If they declined, let it go without comment.` : "";
  const photoWhenHint = ctx.pendingPhoto?.whenText ? ` The photo's file metadata suggests a date of "${ctx.pendingPhoto.whenText}"` + (ctx.pendingPhoto.whereText ? ` and a place near "${ctx.pendingPhoto.whereText}"` : "") + `. Treat this as a soft hint only. If the image itself looks like an older print or scan (black-and-white, faded, period clothing, an old border) while that file date is recent, the date almost certainly records when it was DIGITIZED, not when the moment happened \u2014 do NOT propose it as the memory's date; gently note the gap and ask when the moment itself took place. Otherwise you may offer the date as a question ("the file says maybe ${ctx.pendingPhoto.whenText} \u2014 does that land anywhere near the truth?"), never as established fact.` : "";
  const photoUnsure = ctx.pendingPhoto != null && (ctx.pendingPhoto.isLikelyPhoto === false || ctx.pendingPhoto.visionConfidence === "low");
  const photo = !ctx.pendingPhoto ? "" : photoUnsure ? `

An image was just added, but it did NOT read as a clear family photograph \u2014 it may be a screenshot, a document, a meme, or it was too blurry or unclear to make out. Do NOT invent a description or a memory around it. THIS turn, in your own warm spoken words: gently name that you're having a little trouble seeing it clearly, and ask if they meant to share a different picture (e.g. "Hmm, I'm having trouble making this one out \u2014 it looks like it might be a screenshot. Did you mean to share a different picture with me?"). Don't ask a memory question about it, and describe nothing you can't see. If they say to skip it, set it aside warmly and move on without pressure.` : `

A PHOTOGRAPH was just added to the Moment you're discussing, and you can see it now. Walk it through the photo-series beats this turn, in your own warm, spoken words:
` + (ctx.pendingPhoto.description ? `  BEAT 0 \u2014 VALIDITY: here is a grounded note on what is visible \u2014 ${ctx.pendingPhoto.description} If this reads as a real family photograph, continue. If it instead looks like a screenshot, a document, a meme, or is too blurry or unclear to make out, do NOT invent a memory around it \u2014 warmly name that you're having a little trouble seeing it and ask if they meant to share a different picture, then stop there for this turn.
` : `  BEAT 0 \u2014 VALIDITY: you could not make out this image's details this time. Invent nothing. Acknowledge the photograph warmly, and if it may not have come through cleanly, gently ask whether they'd like to try again or show a different one.
`) + `  BEAT 1 \u2014 ACKNOWLEDGE & DESCRIBE: tell them plainly the picture came through and that you can see it, then note ONLY what is literally visible \u2014 light, setting, objects, the feeling of the scene. Propose, never assert ("this looks like it might be\u2026").${photoWhenHint}
  BEAT 2 \u2014 ELICIT ONE DETAIL (MANDATORY for every photo): before you move on from THIS picture \u2014 to another photo or to closing \u2014 ask exactly ONE open-ended question inviting them to elaborate on it ("what was happening here?", "tell me about this one", "what do you see when you look at it now?"). Never a yes/no, never stacked. This open invitation is required for every photo; the only thing that excuses skipping it is a closed-door signal.
Hard limits: NEVER name or identify anyone in the picture, NEVER guess relationships, NEVER invent a backstory or a date. The people and the story are theirs to tell, not yours to supply.
INTRA-SESSION IDENTITY: the "never name people" rule guards against you INVENTING an identity \u2014 it is not amnesia. If earlier in THIS conversation they already named someone ("that's my dad, Arthur"), you may gently reuse that name when the same person plausibly reappears ("is that Arthur again?") \u2014 offered as an observation open to correction, never as a hard claim, and never extended to anyone they haven't named themselves.
BEAT 3 \u2014 RECEIVE AMBIENTLY: when they tell you about it, take whatever they give \u2014 a story, a single word, or nothing \u2014 and let it be enough. Mirror lightly, in their words. Do NOT echo the same way every photo: rotate your move and never repeat it back-to-back \u2014 VALIDATE (lightly mirror their words) / SYNTHESIZE (tie this photo to an earlier one from this session) / ACKNOWLEDGE & CLEAR (let a phrase breathe, no echo, then the next question). When something concrete is worth keeping, emit a story_draft via the tool (their words, grounded) \u2014 never narrate the save.
If they decline or fall silent in the moment, honor it (Reverence): one gentle acknowledgment, the photo still attaches with no commentary, and you move on without a flicker of pressure.`;
  const completeness = ctx.confirmedInChapter > 0 && ctx.followUpSpent ? `

This chapter has a confirmed Moment. When it feels complete, emit chapter_complete via the tool (with a carryDetail) and speak the transition into the next chapter, carrying: ${chapter.transitionCarry}.` : `

A chapter is complete when at least one Moment is confirmed \u2014 never forced. Chapter aim: ${chapter.milestoneTargets.join(" \xB7 ")}.`;
  return `${SETH_VOICE_AND_GUARDRAILS}${nameLine}

Current chapter: ${chapter.title} (${chapter.era} \xB7 ${chapter.session === "core" ? "Core Session" : "Depth Session"}).
Chapter opening (use this wording when opening the chapter): "${chapter.openingPrompt}"
Primary trigger: ${chapter.primaryTrigger}.
Nuclear episode focus: ${chapter.nuclearFocus.length ? chapter.nuclearFocus.join(", ") : "present-moment anchor"}.${chapter.extraGuidance ? `
${chapter.extraGuidance}` : ""}${followUp}${closed}${carry2}${confirm}${recap}${photo}${completeness}

Speak as Seth for this turn. If \u2014 and only if \u2014 the person has shared something concrete worth preserving,
also call the record_first_thread_payload tool with a grounded draft. Do not mention the tool aloud.`;
}

// packages/shared/src/flowEngine.ts
function reviveSnapshot(raw) {
  const fresh = initialStateSnapshot();
  if (!raw || typeof raw !== "object") return fresh;
  const o = raw;
  const chapterId = CHAPTER_ORDER.includes(o.chapterId) ? o.chapterId : fresh.chapterId;
  const closedScopes = Array.isArray(o.closedScopes) ? o.closedScopes.map((s) => ({
    phrase: String(s.phrase ?? ""),
    matchTokens: Array.isArray(s.matchTokens) ? s.matchTokens : tokensForTopic(String(s.phrase ?? "")),
    closedAt: String(s.closedAt ?? (/* @__PURE__ */ new Date()).toISOString()),
    chapterId: CHAPTER_ORDER.includes(s.chapterId) ? s.chapterId : chapterId
  })) : [];
  return {
    ...fresh,
    chapterId,
    followUpSpent: Boolean(o.followUpSpent),
    turn: typeof o.turn === "number" ? o.turn : 0,
    closedScopes,
    carry: o.carry && typeof o.carry === "object" ? o.carry : {},
    pendingDraft: o.pendingDraft ?? null,
    pendingPhoto: o.pendingPhoto ?? null,
    activeMomentId: typeof o.activeMomentId === "string" ? o.activeMomentId : null,
    confirmedMoments: o.confirmedMoments && typeof o.confirmedMoments === "object" ? o.confirmedMoments : {},
    // Legacy (pre-intro) snapshots revive straight into the walk — never replay
    // the introduction for a session that was already mid-conversation.
    phase: o.phase === "intro" || o.phase === "walk" ? o.phase : "walk",
    subscriberName: typeof o.subscriberName === "string" ? o.subscriberName : null,
    recapPending: Boolean(o.recapPending),
    nextSessionRecapPending: Boolean(o.nextSessionRecapPending),
    photoQueue: Array.isArray(o.photoQueue) ? o.photoQueue : [],
    photosSinceRecap: typeof o.photosSinceRecap === "number" ? o.photosSinceRecap : 0,
    lastActivityAt: typeof o.lastActivityAt === "string" ? o.lastActivityAt : null,
    namedIdentities: Array.isArray(o.namedIdentities) ? o.namedIdentities : []
  };
}
function nextTurn(snapshot) {
  return { ...snapshot, turn: snapshot.turn + 1 };
}
function isFinalChapter(snapshot) {
  return snapshot.chapterId === CHAPTER_ORDER[CHAPTER_ORDER.length - 1];
}
function confirmedInChapter(snapshot) {
  return snapshot.confirmedMoments[snapshot.chapterId] ?? 0;
}
function canAdvance(snapshot) {
  return !isFinalChapter(snapshot) && confirmedInChapter(snapshot) > 0;
}
function advanceChapter(snapshot) {
  if (!canAdvance(snapshot)) return snapshot;
  const idx = CHAPTER_ORDER.indexOf(snapshot.chapterId);
  const next = CHAPTER_ORDER[idx + 1];
  return { ...snapshot, chapterId: next, followUpSpent: false };
}
function applyIntroComplete(snapshot, payload) {
  const name = payload.name?.trim();
  return {
    ...snapshot,
    phase: "walk",
    subscriberName: name ? name : snapshot.subscriberName,
    chapterId: snapshot.phase === "intro" ? CHAPTER_ORDER[0] : snapshot.chapterId,
    followUpSpent: false
  };
}
function jumpToChapter(snapshot, target) {
  if (!CHAPTER_ORDER.includes(target)) return snapshot;
  if (snapshot.phase === "walk" && target === snapshot.chapterId) return snapshot;
  return {
    ...snapshot,
    phase: "walk",
    chapterId: target,
    followUpSpent: false,
    pendingDraft: null
  };
}
function applyChapterComplete(snapshot, payload) {
  if (payload.chapterId !== snapshot.chapterId) return snapshot;
  let next = snapshot;
  if (payload.carryDetail) {
    next = carry(next, `from_${snapshot.chapterId}`, payload.carryDetail);
  }
  return advanceChapter(next);
}
function spendFollowUp(snapshot) {
  return { ...snapshot, followUpSpent: true };
}
function carry(snapshot, key, value) {
  return { ...snapshot, carry: { ...snapshot.carry, [key]: value } };
}
function closeScope(snapshot, phrase, closedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const already = snapshot.closedScopes.some((s) => s.phrase === phrase);
  if (already) return snapshot;
  const scope = {
    phrase,
    matchTokens: tokensForTopic(phrase),
    closedAt,
    chapterId: snapshot.chapterId
  };
  return { ...snapshot, closedScopes: [...snapshot.closedScopes, scope] };
}
function stageDraft(snapshot, payload) {
  return { ...snapshot, pendingDraft: { payload, stagedAtTurn: snapshot.turn } };
}
function clearDraft(snapshot) {
  return { ...snapshot, pendingDraft: null };
}
function setActiveMoment(snapshot, momentId) {
  if (snapshot.activeMomentId === momentId) return snapshot;
  return { ...snapshot, activeMomentId: momentId };
}
function recordConfirmedMoment(snapshot, momentId) {
  const count = (snapshot.confirmedMoments[snapshot.chapterId] ?? 0) + 1;
  return {
    ...snapshot,
    pendingDraft: null,
    activeMomentId: momentId,
    confirmedMoments: { ...snapshot.confirmedMoments, [snapshot.chapterId]: count }
  };
}
function pinPhoto(snapshot, photo) {
  return { ...snapshot, pendingPhoto: photo };
}
function clearPhoto(snapshot) {
  return { ...snapshot, pendingPhoto: null };
}
var AFFIRM = /\b(yes|yeah|yep|yes it does|that's right|thats right|that's it|sounds right|feels right|exactly|correct|perfect|it does|put it on|place it|save it|keep it)\b/i;
var DECLINE = /\b(no|nope|not quite|that's not right|thats not right|don't save|do not save|leave it off|take it off|don't keep|skip it|not that)\b/i;
function detectConfirmation(utterance) {
  if (!utterance) return "unclear";
  const declined = DECLINE.test(utterance);
  const affirmed = AFFIRM.test(utterance);
  if (declined) return "decline";
  if (affirmed) return "confirm";
  return "unclear";
}

// server/src/env.ts
import "dotenv/config";
function bool(v) {
  return v === "true" || v === "1" || v === "yes";
}
function sanitize(v) {
  return (v ?? "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}
var FIRST_THREAD_VOICE = bool(process.env.FIRST_THREAD_VOICE);
var PORT = Number(process.env.PORT ?? 8787);
var CLAUDE_MODEL = sanitize(process.env.CLAUDE_MODEL) || "claude-opus-4-8";
var REQUIRED_WHEN_ENABLED = [
  "HUME_API_KEY",
  "HUME_SECRET_KEY",
  "HUME_CONFIG_ID",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OWNER_SUBSCRIBER_ID"
];
function requireSecrets() {
  const missing = REQUIRED_WHEN_ENABLED.filter((k) => sanitize(process.env[k]) === "");
  if (missing.length > 0) {
    throw new Error(
      `first_thread_voice is enabled but required environment variables are missing: ${missing.join(", ")}. Set them (see .env.example) \u2014 secrets are never hardcoded.`
    );
  }
  return {
    HUME_API_KEY: sanitize(process.env.HUME_API_KEY),
    HUME_SECRET_KEY: sanitize(process.env.HUME_SECRET_KEY),
    HUME_CONFIG_ID: sanitize(process.env.HUME_CONFIG_ID),
    ANTHROPIC_API_KEY: sanitize(process.env.ANTHROPIC_API_KEY),
    SUPABASE_URL: sanitize(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: sanitize(process.env.SUPABASE_SERVICE_ROLE_KEY),
    OWNER_SUBSCRIBER_ID: sanitize(process.env.OWNER_SUBSCRIBER_ID)
  };
}

// server/src/claude.ts
import Anthropic from "@anthropic-ai/sdk";
var anthropic = null;
function client() {
  if (anthropic) return anthropic;
  anthropic = new Anthropic({ apiKey: requireSecrets().ANTHROPIC_API_KEY });
  return anthropic;
}
var RECORD_PAYLOAD_TOOL = {
  name: "record_first_thread_payload",
  description: "Record a structured draft worth saving from what the person actually said. Call this ONLY when the person has shared something concrete worth preserving. Never mention this tool aloud. This does not save anything by itself \u2014 it is a draft for later confirmation.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["moment_draft", "story_draft", "closed_topic_event", "chapter_complete", "intro_complete"]
      },
      title: { type: "string", description: "Short title (moment_draft / story_draft)." },
      summary: { type: "string", description: "Grounded summary (moment_draft)." },
      body: { type: "string", description: "Longer narrative (story_draft)." },
      whenText: { type: "string", description: "Approximate period as spoken; not a parsed date." },
      clusterTags: {
        type: "array",
        items: { type: "string" },
        description: "Career Arc clustering hint, e.g. ['career_map']."
      },
      phrase: { type: "string", description: "Closed-door phrase (closed_topic_event)." },
      sceneType: {
        type: "string",
        enum: ["first_memory", "high_point", "low_point", "turning_point", "life_script_event"],
        description: "McAdams scene-type tag for a moment_draft, when clear."
      },
      carryDetail: {
        type: "string",
        description: "chapter_complete: one concrete detail to carry into the next chapter."
      },
      name: {
        type: "string",
        description: "intro_complete: the subscriber's name as they gave it."
      }
    },
    required: ["kind"]
  }
};
async function generateSethTurn(args) {
  const messages = args.history.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const stream = client().messages.stream(
    {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      // Live voice turn: keep it snappy. Disable thinking and ask for a
      // final-answer-only spoken reply so reasoning doesn't leak into speech.
      thinking: { type: "disabled" },
      system: args.systemPrompt,
      tools: [RECORD_PAYLOAD_TOOL],
      messages
    },
    { signal: args.signal }
  );
  stream.on("text", (delta) => args.onText(delta));
  const final = await stream.finalMessage();
  let spokenText = "";
  let payload = null;
  for (const block of final.content) {
    if (block.type === "text") {
      spokenText += block.text;
    } else if (block.type === "tool_use" && block.name === RECORD_PAYLOAD_TOOL.name) {
      payload = coercePayload(block.input, args.chapterId);
    }
  }
  return { spokenText, payload, stopReason: final.stop_reason };
}
var PHOTO_REVIEW_TOOL = {
  name: "photograph_review",
  description: "Report a grounded, literal review of the image artifact only \u2014 never an identification, relationship, or backstory.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isLikelyFamilyPhotograph: {
        type: "boolean",
        description: "True if this reads as a real family/personal photograph; false for a screenshot, document, meme, chart, or otherwise unrelated graphic."
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: 'How clearly you can make the image out. Use "low" if it is blurry, corrupted, or too ambiguous to describe.'
      },
      description: {
        type: "string",
        description: "One or two plain sentences of ONLY what is literally visible \u2014 setting, number of people, apparent era from clothing/photo style, objects, mood. No names, no relationships, no backstory. Omit if you cannot make the image out."
      }
    },
    required: ["isLikelyFamilyPhotograph", "confidence"]
  }
};
async function describePhotograph(args) {
  try {
    const message = await client().messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 200,
        system: "You help a warm family-history companion notice an old photograph. Assess whether the image is a real family/personal photograph and how clearly you can read it, then describe ONLY what is literally visible. Do NOT name or identify anyone, do NOT guess who they are or their relationships, and do NOT invent any backstory. Report via the photograph_review tool.",
        tools: [PHOTO_REVIEW_TOOL],
        tool_choice: { type: "tool", name: PHOTO_REVIEW_TOOL.name },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: args.strippedJpegBase64
                }
              },
              { type: "text", text: "Review this photograph." }
            ]
          }
        ]
      },
      { signal: args.signal }
    );
    const tool = message.content.find(
      (b) => b.type === "tool_use" && b.name === PHOTO_REVIEW_TOOL.name
    );
    if (!tool) return void 0;
    const o = tool.input;
    const confidence = o.confidence === "high" || o.confidence === "medium" || o.confidence === "low" ? o.confidence : "low";
    const description = typeof o.description === "string" ? o.description.trim() : void 0;
    return {
      isLikelyFamilyPhotograph: o.isLikelyFamilyPhotograph === true,
      confidence,
      description: description || void 0
    };
  } catch (err) {
    const e = err;
    console.error(
      "[claude] photo description failed (non-fatal):",
      JSON.stringify({
        model: CLAUDE_MODEL,
        imageBase64Bytes: args.strippedJpegBase64?.length ?? 0,
        name: e?.name,
        status: e?.status ?? null,
        apiErrorType: e?.error?.error?.type ?? e?.error?.type ?? null,
        requestId: e?.request_id ?? e?.requestID ?? null,
        message: e?.message
      })
    );
    return void 0;
  }
}
function coercePayload(input, chapterId) {
  if (!input || typeof input !== "object") return null;
  const o = input;
  const kind = o.kind;
  if (kind === "moment_draft" && typeof o.title === "string" && typeof o.summary === "string") {
    const scenes = ["first_memory", "high_point", "low_point", "turning_point", "life_script_event"];
    return {
      kind,
      title: o.title,
      summary: o.summary,
      whenText: typeof o.whenText === "string" ? o.whenText : void 0,
      sceneType: typeof o.sceneType === "string" && scenes.includes(o.sceneType) ? o.sceneType : void 0,
      clusterTags: Array.isArray(o.clusterTags) ? o.clusterTags : void 0,
      chapterId
    };
  }
  if (kind === "chapter_complete") {
    return {
      kind,
      chapterId,
      carryDetail: typeof o.carryDetail === "string" ? o.carryDetail : void 0
    };
  }
  if (kind === "story_draft" && typeof o.title === "string" && typeof o.body === "string") {
    return { kind, title: o.title, body: o.body, chapterId };
  }
  if (kind === "closed_topic_event" && typeof o.phrase === "string") {
    return { kind, phrase: o.phrase, source: "claude", chapterId };
  }
  if (kind === "intro_complete" && typeof o.name === "string" && o.name.trim() !== "") {
    return { kind, name: o.name.trim() };
  }
  return null;
}

// server/src/supabase.ts
import { createClient } from "@supabase/supabase-js";
var client2 = null;
function getDb() {
  return db();
}
function db() {
  if (client2) return client2;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireSecrets();
  client2 = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client2;
}
async function createSession() {
  const { OWNER_SUBSCRIBER_ID } = requireSecrets();
  const snapshot = initialStateSnapshot();
  const prior = await db().from("rot_moments").select("moment_id", { count: "exact", head: true }).eq("subscriber_id", OWNER_SUBSCRIBER_ID).eq("source", "first_thread_voice").eq("status", "committed");
  if ((prior.count ?? 0) > 0) snapshot.nextSessionRecapPending = true;
  const { data, error } = await db().from("rot_capture_sessions").insert({
    subscriber_id: OWNER_SUBSCRIBER_ID,
    entry_point: "first_thread",
    companion: "seth",
    status: "in_progress",
    state_snapshot: snapshot
  }).select("session_id").single();
  if (error) throw new Error(`createSession failed: ${error.message}`);
  return { sessionId: data.session_id, snapshot };
}
async function updateSession(sessionId, patch) {
  const update = {};
  if (patch.snapshot) update.state_snapshot = patch.snapshot;
  if (patch.status) {
    update.status = patch.status;
    if (patch.status === "complete") update.completed_at = (/* @__PURE__ */ new Date()).toISOString();
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await db().from("rot_capture_sessions").update(update).eq("session_id", sessionId);
  if (error) throw new Error(`updateSession failed: ${error.message}`);
}
async function appendExchange(args) {
  const { data, error } = await db().from("first_thread_exchanges").insert({
    session_id: args.sessionId,
    role: args.role,
    content: args.content,
    interrupted: args.interrupted ?? false
  }).select("*").single();
  if (error) throw new Error(`appendExchange failed: ${error.message}`);
  return data;
}
async function getSession(sessionId) {
  const { data, error } = await db().from("rot_capture_sessions").select("subscriber_id, state_snapshot, recap_last_at").eq("session_id", sessionId).single();
  if (error || !data) return null;
  return {
    subscriberId: data.subscriber_id,
    snapshot: reviveSnapshot(data.state_snapshot),
    recapLastAt: data.recap_last_at ?? null
  };
}
async function findResumableSession() {
  const { OWNER_SUBSCRIBER_ID } = requireSecrets();
  const { data, error } = await db().from("rot_capture_sessions").select("session_id, state_snapshot").eq("subscriber_id", OWNER_SUBSCRIBER_ID).eq("entry_point", "first_thread").eq("status", "in_progress").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return null;
  return { sessionId: data.session_id, snapshot: reviveSnapshot(data.state_snapshot) };
}
var PHOTO_BUCKET = process.env.SUPABASE_PHOTO_BUCKET ?? "first-thread-photos";
async function ensurePhotoBucket() {
  const storage = db().storage;
  const { data } = await storage.getBucket(PHOTO_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(PHOTO_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`ensurePhotoBucket failed: ${error.message}`);
  }
}
async function uploadAndPinPhoto(args) {
  await ensurePhotoBucket();
  const storage = db().storage.from(PHOTO_BUCKET);
  const base = `${args.momentId}/${Date.now()}`;
  const derivativePath = `${base}/photo.jpg`;
  const up = await storage.upload(derivativePath, args.strippedJpeg, {
    contentType: "image/jpeg",
    upsert: false
  });
  if (up.error) throw new Error(`photo upload failed: ${up.error.message}`);
  if (args.retainOriginal && args.original) {
    const orig = await storage.upload(`${base}/original.jpg`, args.original, {
      contentType: "image/jpeg",
      upsert: false
    });
    if (orig.error) throw new Error(`original upload failed: ${orig.error.message}`);
  }
  const { data, error } = await db().from("media_assets").insert({
    moment_id: args.momentId,
    asset_type: "photo",
    storage_url: `${PHOTO_BUCKET}/${derivativePath}`,
    caption: args.caption ?? null,
    retain_original: args.retainOriginal
  }).select("asset_id").single();
  if (error) throw new Error(`media_assets insert failed: ${error.message}`);
  return { assetId: data.asset_id, storagePath: `${PHOTO_BUCKET}/${derivativePath}` };
}

// server/src/riverWrites.ts
import { createHash } from "node:crypto";
function idempotencyKey(args) {
  return createHash("sha256").update(`${args.subscriberId}|${args.sessionId}|${args.chapter}|${args.turn}`).digest("hex");
}
async function writeAmbientMoment(args) {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn
  });
  const db2 = getDb();
  const existing = await db2.from("rot_moments").select("moment_id").eq("sync_idempotency_key", key).maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id, merged: true };
  }
  const clusterTags = Array.isArray(args.draft.clusterTags) ? args.draft.clusterTags : [];
  const { data, error } = await db2.from("rot_moments").insert({
    subscriber_id: args.subscriberId,
    title: args.draft.title,
    summary: args.draft.summary,
    moment_type: "milestone",
    status: "pending_review",
    // ← ambient write; not committed yet
    visibility: "private",
    // B4: explicit, never the DB default
    companion: "seth",
    source: "first_thread_voice",
    medium: "voice",
    chapter: args.draft.chapterId,
    layer: 2,
    cluster_tags: clusterTags,
    subtype: args.draft.sceneType ?? null,
    created_by: "seth",
    sync_idempotency_key: key
  }).select("moment_id").single();
  if (error) throw new Error(`writeAmbientMoment failed: ${error.message}`);
  return { momentId: data.moment_id, merged: false };
}
async function writeAmbientStory(args) {
  const key = idempotencyKey({
    subscriberId: args.subscriberId,
    sessionId: args.sessionId,
    chapter: args.draft.chapterId,
    turn: args.turn
  });
  const db2 = getDb();
  const existing = await db2.from("rot_moments").select("moment_id").eq("sync_idempotency_key", key).maybeSingle();
  if (existing.data?.moment_id) {
    return { momentId: existing.data.moment_id, merged: true };
  }
  const { data, error } = await db2.from("rot_moments").insert({
    subscriber_id: args.subscriberId,
    title: args.draft.title,
    summary: null,
    narrative_body: args.draft.body,
    moment_type: "story",
    status: "pending_review",
    // ← ambient write; not committed yet
    visibility: "private",
    // B4: explicit
    companion: "seth",
    source: "first_thread_voice",
    medium: "voice",
    chapter: args.draft.chapterId,
    layer: 3,
    cluster_root_id: args.anchorMomentId,
    created_by: "seth",
    sync_idempotency_key: key
  }).select("moment_id").single();
  if (error) throw new Error(`writeAmbientStory failed: ${error.message}`);
  return { momentId: data.moment_id, merged: false };
}
async function getPendingReviewRows(args) {
  const db2 = getDb();
  const { data, error } = await db2.from("rot_moments").select("moment_id, title, chapter").eq("subscriber_id", args.subscriberId).eq("source", "first_thread_voice").eq("status", "pending_review").order("created_at", { ascending: true });
  if (error) throw new Error(`getPendingReviewRows failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    momentId: r.moment_id,
    title: r.title,
    chapter: r.chapter
  }));
}
async function commitPendingReview(momentIds) {
  if (momentIds.length === 0) return;
  const db2 = getDb();
  const { error } = await db2.from("rot_moments").update({ status: "committed" }).in("moment_id", momentIds);
  if (error) throw new Error(`commitPendingReview failed: ${error.message}`);
}
async function dropPendingReview(momentId) {
  const db2 = getDb();
  const { error } = await db2.from("rot_moments").delete().eq("moment_id", momentId).eq("status", "pending_review");
  if (error) throw new Error(`dropPendingReview failed: ${error.message}`);
}
async function markRecapFired(sessionId) {
  const db2 = getDb();
  const { error } = await db2.from("rot_capture_sessions").update({ recap_last_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("session_id", sessionId);
  if (error) throw new Error(`markRecapFired failed: ${error.message}`);
}
async function getPriorSessionMoments(args) {
  const db2 = getDb();
  const { data, error } = await db2.from("rot_moments").select("moment_id, title, chapter").eq("subscriber_id", args.subscriberId).eq("source", "first_thread_voice").eq("status", "committed").neq("sync_idempotency_key", "").order("created_at", { ascending: false }).limit(args.limit ?? 5);
  if (error) throw new Error(`getPriorSessionMoments failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    momentId: r.moment_id,
    title: r.title,
    chapter: r.chapter
  }));
}
function buildNextSessionRecapPrompt(moments) {
  if (moments.length === 0) return "";
  const titles = moments.map((m) => m.title);
  let listStr;
  if (titles.length === 1) {
    listStr = titles[0];
  } else if (titles.length === 2) {
    listStr = `${titles[0]} and ${titles[1]}`;
  } else {
    const last = titles[titles.length - 1];
    const rest = titles.slice(0, -1).join(", ");
    listStr = `${rest}, and ${last}`;
  }
  return `Last time you told me about ${listStr}. I've held onto those. Shall we carry on?`;
}
function buildMidSessionRecapPrompt(rows) {
  if (rows.length === 0) return "";
  const titles = rows.map((r) => r.title);
  let listStr;
  if (titles.length === 1) {
    listStr = titles[0];
  } else if (titles.length === 2) {
    listStr = `${titles[0]} and ${titles[1]}`;
  } else {
    const last = titles[titles.length - 1];
    const rest = titles.slice(0, -1).join(", ");
    listStr = `${rest}, and ${last}`;
  }
  const bothOrAll = titles.length === 1 ? "that" : titles.length === 2 ? "both of those" : "all of those";
  return `Before we move on \u2014 you mentioned ${listStr}. I've held onto ${bothOrAll}. Does that feel right?`;
}
async function recordClosedTopicEvent(args) {
  const topicTokens = topicFromUtterance(args.utterance, args.payload.phrase);
  const tokens = topicTokens.length > 0 ? topicTokens : tokensForTopic(args.payload.phrase);
  const db2 = getDb();
  const { error } = await db2.from("subscriber_closed_topics").insert({
    subscriber_id: args.subscriberId,
    topic: topicTokens.length > 0 ? topicTokens.join(" ") : args.payload.phrase,
    signal: "closed_door",
    status: "closed",
    chapter: args.payload.chapterId,
    match_tokens: tokens
  });
  if (error) throw new Error(`recordClosedTopicEvent failed: ${error.message}`);
}

// server/src/clm.ts
var RECAP_INTERVAL_MS = 20 * 60 * 1e3;
function sseChunk(res, content) {
  const payload = {
    id: `chatcmpl-ft-${Date.now()}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
  res.write(`data: ${JSON.stringify(payload)}

`);
}
function sseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}
function latestSubscriberUtterance(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}
function recapTimeElapsed(recapLastAt) {
  if (!recapLastAt) return false;
  return Date.now() - new Date(recapLastAt).getTime() > RECAP_INTERVAL_MS;
}
async function handleClmRequest(req, res) {
  const body = req.body;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const sessionId = body?.custom_session_id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const session = sessionId ? await getSession(sessionId) : null;
  let snapshot = session?.snapshot ?? initialStateSnapshot();
  const subscriberId = session?.subscriberId ?? null;
  const utterance = latestSubscriberUtterance(messages);
  const previousChapterId = snapshot.chapterId;
  snapshot = nextTurn(snapshot);
  const closed = detectClosedDoor(utterance);
  if (closed) {
    snapshot = closeScope(snapshot, closed.phrase);
    snapshot = clearDraft(snapshot);
    if (snapshot.recapPending && subscriberId && sessionId) {
      const pendingRows = await safe(
        () => getPendingReviewRows({ subscriberId, sessionId })
      ) ?? [];
      const matchingRow = pendingRows.find(
        (r) => r.title.toLowerCase().includes(closed.phrase.toLowerCase())
      );
      if (matchingRow) {
        await safe(() => dropPendingReview(matchingRow.momentId));
        await safe(
          () => appendExchange({
            sessionId,
            role: "system",
            content: `[recap/reverence] dropped pending_review "${matchingRow.title}" on closed-door signal`
          })
        );
      }
    }
    if (sessionId && subscriberId) {
      await safe(
        () => appendExchange({
          sessionId,
          role: "system",
          content: `[reverence] closed-door signal "${closed.matchedText}" \u2192 scope closed in chapter ${snapshot.chapterId}`
        })
      );
      await safe(
        () => recordClosedTopicEvent({
          subscriberId,
          sessionId,
          payload: {
            kind: "closed_topic_event",
            phrase: closed.phrase,
            source: "reverence_prefilter",
            chapterId: snapshot.chapterId
          },
          utterance
        })
      );
      await safe(() => updateSession(sessionId, { snapshot }));
    }
    sseChunk(res, REVERENCE_ACKNOWLEDGMENT);
    sseDone(res);
    return;
  }
  if (snapshot.phase === "intro") {
    const introPrompt = buildSethIntroPrompt({ subscriberName: snapshot.subscriberName });
    try {
      const result = await generateSethTurn({
        systemPrompt: introPrompt,
        history: messages,
        chapterId: snapshot.chapterId,
        onText: (delta) => sseChunk(res, delta),
        signal: abort.signal
      });
      if (result.payload?.kind === "intro_complete") {
        snapshot = applyIntroComplete(snapshot, result.payload);
        if (sessionId && subscriberId) {
          await safe(
            () => appendExchange({
              sessionId,
              role: "system",
              content: `[intro] name captured \u2192 "${snapshot.subscriberName ?? ""}"; entering ${snapshot.chapterId}`
            })
          );
        }
      }
      if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
      sseDone(res);
    } catch (err) {
      if (abort.signal.aborted) {
        if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
        res.end();
        return;
      }
      console.error("[clm] intro generation error:", err);
      sseChunk(res, "I'm sorry \u2014 I lost my thread for a moment. Could you say that once more?");
      sseDone(res);
    }
    return;
  }
  if (snapshot.nextSessionRecapPending && subscriberId && sessionId) {
    const verdict = detectConfirmation(utterance);
    if (verdict === "confirm" || snapshot.turn > 1) {
      snapshot = { ...snapshot, nextSessionRecapPending: false };
    } else {
      const priorMoments = await safe(
        () => getPriorSessionMoments({ subscriberId, currentSessionId: sessionId })
      ) ?? [];
      if (priorMoments.length > 0) {
        const recapText = buildNextSessionRecapPrompt(priorMoments);
        sseChunk(res, recapText);
        await safe(
          () => appendExchange({
            sessionId,
            role: "system",
            content: `[recap/next-session] surfaced ${priorMoments.length} prior committed moments`
          })
        );
        await safe(() => updateSession(sessionId, { snapshot }));
        sseDone(res);
        return;
      }
      snapshot = { ...snapshot, nextSessionRecapPending: false };
    }
  }
  if (snapshot.recapPending && subscriberId && sessionId) {
    const pendingRows = await safe(
      () => getPendingReviewRows({ subscriberId, sessionId })
    ) ?? [];
    const verdict = detectConfirmation(utterance);
    if (verdict === "confirm" || utterance.trim() === "") {
      if (pendingRows.length > 0) {
        const ids = pendingRows.map((r) => r.momentId);
        await safe(() => commitPendingReview(ids));
        for (const row of pendingRows) {
          snapshot = recordConfirmedMoment(snapshot, row.momentId);
        }
        await safe(
          () => appendExchange({
            sessionId,
            role: "system",
            content: `[recap] confirmed ${ids.length} moments: ${pendingRows.map((r) => r.title).join(", ")}`
          })
        );
      }
      snapshot = { ...snapshot, recapPending: false };
    } else if (verdict === "decline") {
      for (const row of pendingRows) {
        await safe(() => dropPendingReview(row.momentId));
      }
      await safe(
        () => appendExchange({
          sessionId,
          role: "system",
          content: `[recap] subscriber declined batch \u2014 dropped ${pendingRows.length} pending_review rows`
        })
      );
      snapshot = { ...snapshot, recapPending: false };
    }
  }
  if (!snapshot.recapPending && subscriberId && sessionId) {
    const chapterBoundary = snapshot.chapterId !== previousChapterId;
    const timeElapsed = recapTimeElapsed(session?.recapLastAt ?? null);
    if ((chapterBoundary || timeElapsed) && snapshot.turn > 1) {
      const pendingRows = await safe(
        () => getPendingReviewRows({ subscriberId, sessionId })
      ) ?? [];
      if (pendingRows.length > 0) {
        const recapText = buildMidSessionRecapPrompt(pendingRows);
        sseChunk(res, recapText);
        snapshot = { ...snapshot, recapPending: true };
        await safe(() => markRecapFired(sessionId));
        await safe(
          () => appendExchange({
            sessionId,
            role: "system",
            content: `[recap] ${chapterBoundary ? "chapter boundary" : "20-min elapsed"} \u2014 surfaced ${pendingRows.length} pending_review rows for confirmation`
          })
        );
        await safe(() => updateSession(sessionId, { snapshot }));
        sseDone(res);
        return;
      }
      if (timeElapsed) await safe(() => markRecapFired(sessionId));
    }
  }
  const systemPrompt = buildSethSystemPrompt({
    chapterId: snapshot.chapterId,
    subscriberName: snapshot.subscriberName,
    followUpSpent: snapshot.followUpSpent,
    closedScopes: snapshot.closedScopes,
    carry: snapshot.carry,
    pendingDraft: snapshot.pendingDraft,
    pendingPhoto: snapshot.pendingPhoto,
    confirmedInChapter: confirmedInChapter(snapshot),
    recapPending: snapshot.recapPending
  });
  try {
    const result = await generateSethTurn({
      systemPrompt,
      history: messages,
      chapterId: snapshot.chapterId,
      onText: (delta) => sseChunk(res, delta),
      signal: abort.signal
    });
    if (result.payload) {
      switch (result.payload.kind) {
        case "closed_topic_event": {
          snapshot = closeScope(snapshot, result.payload.phrase);
          if (sessionId && subscriberId) {
            const payload = result.payload;
            await safe(
              () => recordClosedTopicEvent({ subscriberId, sessionId, payload, utterance })
            );
          }
          break;
        }
        case "chapter_complete": {
          snapshot = applyChapterComplete(snapshot, result.payload);
          break;
        }
        case "moment_draft": {
          if (subscriberId && sessionId) {
            const written = await safe(
              () => writeAmbientMoment({
                subscriberId,
                sessionId,
                draft: result.payload,
                turn: snapshot.turn
              })
            );
            if (written) {
              snapshot = setActiveMoment(snapshot, written.momentId);
              await safe(
                () => appendExchange({
                  sessionId,
                  role: "system",
                  content: `[river/ambient] moment_draft "${result.payload.title}" \u2192 pending_review ${written.momentId} (active pin target)`
                })
              );
            }
          }
          snapshot = stageDraft(snapshot, result.payload);
          break;
        }
        case "story_draft": {
          if (subscriberId && sessionId) {
            const anchorId = snapshot.pendingPhoto?.momentId ?? snapshot.activeMomentId ?? null;
            const written = await safe(
              () => writeAmbientStory({
                subscriberId,
                sessionId,
                draft: result.payload,
                turn: snapshot.turn,
                anchorMomentId: anchorId
              })
            );
            if (written && snapshot.pendingPhoto) {
              snapshot = clearPhoto(snapshot);
            }
            if (written) {
              await safe(
                () => appendExchange({
                  sessionId,
                  role: "system",
                  content: `[river/ambient] story_draft "${result.payload.title}" \u2192 pending_review ${written.momentId}`
                })
              );
            }
          }
          snapshot = stageDraft(snapshot, result.payload);
          break;
        }
      }
    }
    if (!snapshot.followUpSpent) snapshot = spendFollowUp(snapshot);
    if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
    sseDone(res);
  } catch (err) {
    if (abort.signal.aborted) {
      if (sessionId) await safe(() => updateSession(sessionId, { snapshot }));
      res.end();
      return;
    }
    console.error("[clm] generation error:", err);
    sseChunk(res, "I'm sorry \u2014 I lost my thread for a moment. Could you say that once more?");
    sseDone(res);
  }
}
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("[clm] persistence error (non-fatal):", err);
    return null;
  }
}

// server/src/humeToken.ts
import { fetchAccessToken } from "hume";
async function mintHumeAccessToken() {
  const { HUME_API_KEY, HUME_SECRET_KEY, HUME_CONFIG_ID } = requireSecrets();
  const accessToken = await fetchAccessToken({ apiKey: HUME_API_KEY, secretKey: HUME_SECRET_KEY });
  if (!accessToken) throw new Error("Hume returned an empty access token");
  return { accessToken, configId: HUME_CONFIG_ID };
}

// server/src/photos.ts
async function handlePhotoUpload(req, res) {
  const { sessionId, strippedBase64, originalBase64, retainOriginal, whenText, whereText } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof strippedBase64 !== "string") {
    res.status(400).json({ error: "sessionId and strippedBase64 are required" });
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  if (!session.snapshot.activeMomentId) {
    res.status(409).json({
      error: "no active Moment to pin to yet \u2014 confirm a Moment with Seth first, then add the photograph"
    });
    return;
  }
  try {
    const stripped = Buffer.from(strippedBase64, "base64");
    const original = retainOriginal === true && typeof originalBase64 === "string" ? Buffer.from(originalBase64, "base64") : null;
    const { assetId } = await uploadAndPinPhoto({
      momentId: session.snapshot.activeMomentId,
      strippedJpeg: stripped,
      original,
      retainOriginal: retainOriginal === true
    });
    const review = await describePhotograph({ strippedJpegBase64: strippedBase64 });
    let snapshot = clearDraft(session.snapshot);
    snapshot = pinPhoto(snapshot, {
      assetId,
      momentId: session.snapshot.activeMomentId,
      whenText: typeof whenText === "string" && whenText ? whenText : void 0,
      whereText: typeof whereText === "string" && whereText ? whereText : void 0,
      description: review?.description,
      isLikelyPhoto: review?.isLikelyFamilyPhotograph,
      visionConfidence: review?.confidence
    });
    await updateSession(sessionId, { snapshot });
    res.json({ assetId, momentId: session.snapshot.activeMomentId });
  } catch (err) {
    console.error("[photos]", err);
    res.status(500).json({ error: "photo upload failed" });
  }
}

// server/src/index.ts
var app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, firstThreadVoice: FIRST_THREAD_VOICE });
});
function requireFlag(_req, res, next) {
  if (!FIRST_THREAD_VOICE) {
    res.status(404).json({ error: "first_thread_voice is disabled" });
    return;
  }
  next();
}
app.get("/api/hume/token", requireFlag, async (_req, res) => {
  try {
    res.json(await mintHumeAccessToken());
  } catch (err) {
    console.error("[hume/token]", err);
    res.status(500).json({ error: "failed to mint Hume access token" });
  }
});
app.post("/api/sessions", requireFlag, async (_req, res) => {
  try {
    const { sessionId, snapshot } = await createSession();
    res.json({ sessionId, snapshot });
  } catch (err) {
    console.error("[sessions:create]", err);
    res.status(500).json({ error: "failed to create session" });
  }
});
app.patch("/api/sessions/:id", requireFlag, async (req, res) => {
  const id = req.params.id;
  const status = req.body?.status;
  if (!id) {
    res.status(400).json({ error: "session id required" });
    return;
  }
  if (status && !["in_progress", "complete", "abandoned"].includes(status)) {
    res.status(400).json({ error: "invalid status" });
    return;
  }
  try {
    await updateSession(id, { status });
    res.json({ ok: true });
  } catch (err) {
    console.error("[sessions:update]", err);
    res.status(500).json({ error: "failed to update session" });
  }
});
app.post("/api/exchanges", requireFlag, async (req, res) => {
  const { sessionId, role, content, interrupted } = req.body ?? {};
  const validRoles = ["companion", "subscriber", "system"];
  if (typeof sessionId !== "string" || !validRoles.includes(role) || typeof content !== "string") {
    res.status(400).json({ error: "sessionId, role (companion|subscriber|system) and content are required" });
    return;
  }
  try {
    const row = await appendExchange({ sessionId, role, content, interrupted: Boolean(interrupted) });
    res.json({ id: row.id, created_at: row.created_at });
  } catch (err) {
    console.error("[exchanges:append]", err);
    res.status(500).json({ error: "failed to append exchange" });
  }
});
app.get("/api/sessions/resumable", requireFlag, async (_req, res) => {
  try {
    res.json(await findResumableSession() ?? {});
  } catch (err) {
    console.error("[sessions:resumable]", err);
    res.status(500).json({ error: "failed to look up resumable session" });
  }
});
app.get("/api/sessions/:id/state", requireFlag, async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json({ snapshot: session.snapshot });
  } catch (err) {
    console.error("[sessions:state]", err);
    res.status(500).json({ error: "failed to load session state" });
  }
});
app.post("/api/sessions/:id/chapter", requireFlag, async (req, res) => {
  const id = req.params.id;
  const chapterId = req.body?.chapterId;
  if (!id) {
    res.status(400).json({ error: "session id required" });
    return;
  }
  if (!chapterId || !CHAPTER_ORDER.includes(chapterId)) {
    res.status(400).json({ error: "valid chapterId required" });
    return;
  }
  try {
    const session = await getSession(id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const snapshot = jumpToChapter(session.snapshot, chapterId);
    await updateSession(id, { snapshot });
    res.json({ snapshot });
  } catch (err) {
    console.error("[sessions:chapter]", err);
    res.status(500).json({ error: "failed to set chapter" });
  }
});
app.post("/api/photos", requireFlag, handlePhotoUpload);
app.post("/api/clm/chat/completions", requireFlag, handleClmRequest);
function start() {
  if (process.env.VERCEL) return;
  if (FIRST_THREAD_VOICE) {
    try {
      requireSecrets();
    } catch (err) {
      console.error(`
[first_thread_voice] cannot start:
  ${err.message}
`);
      process.exit(1);
    }
  }
  app.listen(PORT, () => {
    console.log(
      `[throughline server] listening on :${PORT} \u2014 first_thread_voice ${FIRST_THREAD_VOICE ? "ON" : "OFF (routes 404)"}`
    );
  });
}
start();

// server/src/vercelEntry.ts
var vercelEntry_default = app;
export {
  vercelEntry_default as default
};
