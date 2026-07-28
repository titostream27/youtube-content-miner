import type {
  ChannelSummary,
  EpisodeCandidate,
  Transcript,
  TranscriptCue,
} from '@/lib/domain/types';
import { termCoverage } from '@/lib/scoring/text';

/**
 * Deterministic demo catalogue.
 *
 * Demo mode exists so the entire pipeline - discovery, opportunity scoring,
 * transcript extraction, moment detection, clip scoring, thresholding, export -
 * can be exercised with an empty `.env`. No YouTube key, no LLM key, no cost.
 *
 * The content below is original synthetic podcast dialogue written to span a
 * realistic quality range: strong hooks with clean payoffs, mid-tier
 * exposition, sponsor reads, filler, and segments that deliberately depend on
 * earlier context so the `standalone` quality gate has something to catch.
 *
 * This is clearly labelled as synthetic everywhere it surfaces in the UI. It is
 * demo data, not a simulation of real YouTube results.
 */

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

const FIXTURE_CHANNELS: ChannelSummary[] = [
  {
    channelId: 'demo-chan-signal',
    title: 'The Signal Room',
    handle: '@thesignalroom',
    thumbnailUrl: null,
    subscriberCount: 842_000,
    videoCount: 312,
    viewCount: 128_400_000,
  },
  {
    channelId: 'demo-chan-founders',
    title: 'Founders Off Record',
    handle: '@foundersoffrecord',
    thumbnailUrl: null,
    subscriberCount: 297_000,
    videoCount: 186,
    viewCount: 31_900_000,
  },
  {
    channelId: 'demo-chan-capital',
    title: 'Capital & Consequence',
    handle: '@capitalconsequence',
    thumbnailUrl: null,
    subscriberCount: 1_540_000,
    videoCount: 421,
    viewCount: 402_000_000,
  },
  {
    channelId: 'demo-chan-mind',
    title: 'The Mind Long Form',
    handle: '@themindlongform',
    thumbnailUrl: null,
    subscriberCount: 613_000,
    videoCount: 240,
    viewCount: 74_500_000,
  },
  {
    channelId: 'demo-chan-build',
    title: 'Build Something Weird',
    handle: '@buildsomethingweird',
    thumbnailUrl: null,
    subscriberCount: 88_000,
    videoCount: 97,
    viewCount: 6_200_000,
  },
  {
    channelId: 'demo-chan-clinic',
    title: 'The Clinic Hours',
    handle: '@theclinichours',
    thumbnailUrl: null,
    subscriberCount: 405_000,
    videoCount: 158,
    viewCount: 48_100_000,
  },
];

/* -------------------------------------------------------------------------- */
/* Transcript passages                                                        */
/* -------------------------------------------------------------------------- */

interface FixturePassage {
  id: string;
  topics: string[];
  text: string;
}

const PASSAGES: FixturePassage[] = [
  {
    id: 'p-founder-parking-lot',
    topics: ['startup', 'business', 'motivation'],
    text: "Everyone thinks the hardest part of starting a company is the idea. It isn't. The hardest part is the eighteen months where nothing works and nobody tells you that's normal. I remember sitting in a parking lot in Fremont after our ninth investor meeting, and I had this moment where I genuinely could not remember why I'd started. We had eleven thousand dollars in the bank and a payroll of forty thousand. And the thing that saved us wasn't a pivot or a strategy. It was one customer who emailed to say they'd cancelled their old vendor because of us. I printed that email. I still have it. Because when you're that deep, you don't need a plan. You need proof that one human being cares.",
  },
  {
    id: 'p-marketing-listening',
    topics: ['marketing', 'business'],
    text: "The biggest mistake I see marketers make is optimising the thing that doesn't matter. They'll spend six weeks testing a button colour and never once talk to a customer. Here's the test I give every team. Can you tell me, in one sentence, what your customer believed before they bought and what they believe now? If you can't answer that, you don't have a positioning problem, you have a listening problem. And no amount of paid spend fixes a listening problem. It just makes you wrong faster and more expensively.",
  },
  {
    id: 'p-finance-compound',
    topics: ['finance', 'business'],
    text: "Compound interest is the most oversold idea in personal finance, and I say that as someone who built a career on it. Not because it's false, it's true, but because it gets used to sell people patience they cannot afford. If you are twenty three and your rent is sixty percent of your income, the answer isn't invest earlier. The answer is income. Nobody wants to hear that, because income is hard and index funds are easy. But I have never met a single person who compounded their way out of a bad salary.",
  },
  {
    id: 'p-psych-adaptation',
    topics: ['psychology', 'health', 'mindset'],
    text: "There was a study I keep coming back to. They asked people to predict how happy they would be six months after either winning a lottery or losing the use of their legs. Both groups were wildly wrong. The lottery winners overestimated. The accident victims underestimated by more. And what that tells you isn't that humans are bad at maths. It's that we are terrible at imagining our own adaptation. You are far more resilient than the version of you that is currently afraid.",
  },
  {
    id: 'p-ai-judgment',
    topics: ['ai', 'artificial intelligence', 'startup', 'business'],
    text: "People keep asking me when AI will replace programmers. Wrong question. The right question is what happens to a company when the cost of writing code drops by ninety percent but the cost of knowing what to build stays exactly the same. Because that is the world we are in right now. And what I am watching happen inside every engineering organisation I advise is the same thing. The bottleneck moved. It used to be implementation. Now it is judgment. And judgment does not scale by hiring.",
  },
  {
    id: 'p-health-sleep',
    topics: ['health', 'productivity'],
    text: "I spent four years telling patients to sleep more before I understood why it wasn't working. Telling an exhausted person to sleep more is like telling a drowning person to breathe more. The instruction isn't the problem. So we stopped prescribing sleep and started removing the things stealing it. Light after ten. Caffeine after two. The phone out of the bedroom. And adherence went from about twenty percent to almost seventy. Same goal. We just stopped asking people to want it harder.",
  },
  {
    id: 'p-survivorship',
    topics: ['startup', 'business', 'controversial'],
    text: "I'll say the unpopular thing. Most startup advice is survivorship bias with a podcast microphone in front of it, including some of mine. When a founder tells you what worked, they are describing one path through a maze, and they are describing it backwards, from the exit. The useful question isn't what did you do. It's what did you believe that turned out to be wrong. Almost nobody asks it, because it's a worse story.",
  },
  {
    id: 'p-leadership-firing',
    topics: ['leadership', 'business', 'management'],
    text: "The first time I had to fire someone I liked, I did everything wrong. I softened it so much that he left the room thinking he had been given a warning. He found out he was fired from HR two days later. What I learned is that clarity is the kindest thing you have. Every bit of vagueness you add to protect yourself, the other person pays for later, with interest.",
  },
  {
    id: 'p-focus-inventory',
    topics: ['productivity', 'mindset', 'business'],
    text: "Here's what nobody tells you about focus. It is not a discipline problem, it is an inventory problem. If you have forty open commitments, no morning routine on earth saves you. I make everyone I coach do the same brutal exercise. Write down every single thing you have said yes to. Not tasks. Commitments. Most people land somewhere between thirty and sixty. Then we kill half. And suddenly they are disciplined.",
  },
  {
    id: 'p-father-sold',
    topics: ['business', 'story', 'finance'],
    text: "My father sold his business at sixty one for less than he had been offered nine years earlier. And I asked him, because I was young and stupid, whether he regretted waiting. And he said something I think about constantly. He said the offer nine years ago would have made him rich and useless. Those nine years, he said, were the only part of the whole thing he actually got to keep.",
  },
  {
    id: 'p-three-questions',
    topics: ['finance', 'startup', 'business'],
    text: "There are three questions I ask before I invest, and they have been the same for eleven years. One, what has to be true for this to be a big company. Two, who has to be wrong. Three, what does the founder know that I would only learn by working here for a year. The third one is the only one that has ever made me money. The first two just keep me from embarrassing myself.",
  },
  {
    id: 'p-funny-name-field',
    topics: ['startup', 'funny', 'business'],
    text: "We once shipped a feature that only worked if your name was shorter than the field label. [laughter] Nobody caught it for eleven days, because everyone on the engineering team was named Dan, Sam, or Max. Our first support ticket was from a woman named Konstantina, and it just said, your product hates me. She was right. It did.",
  },
  {
    id: 'p-filler-rambling',
    topics: [],
    text: "Yeah, yeah, and so, you know, that's the thing, right. It's like, um, I don't know. I mean it depends. It depends on so many things and I think, you know, a lot of people, they kind of, sort of assume that it's, like, one thing, but anyway. Where were we. Right. So.",
  },
  {
    id: 'p-dangling-reference',
    topics: [],
    text: "And that is exactly what he was saying earlier, which is why the second one matters more than the first one. As I mentioned, it comes back to that same framework we were talking about before the break. So it's the same thing, basically, just applied to the other side of it.",
  },
  {
    id: 'p-sponsor-read',
    topics: [],
    text: "Before we get into it, a quick word from today's sponsor. If you have been looking for a better way to manage your team's documents, our friends over at the platform we use have a link in the description. Use the code from the show and you get twenty percent off your first three months. Alright. Where were we.",
  },
  {
    id: 'p-neutral-history',
    topics: ['business', 'startup'],
    text: "So the company was founded in twenty fourteen, and at that point the market was maybe two hundred million dollars, mostly in North America. Over the next few years it grew, I would say, reasonably steadily. We hired a sales leader in twenty seventeen. Revenue roughly doubled year over year for a while after that, then flattened out.",
  },
  {
    id: 'p-pricing-standard',
    topics: ['business', 'marketing', 'finance'],
    text: "The way we think about pricing is fairly standard. You look at what the alternative costs the customer, you look at the value you deliver, and you try to capture some reasonable fraction of the difference. Most companies undercharge early. That is the main thing I would say about it.",
  },
  {
    id: 'p-question-wire',
    topics: ['business', 'story'],
    text: "Can I ask you something I have never asked on air. When you sold, did you tell your team before or after the wire cleared? Because I have heard you describe that week three different ways in three different interviews, and I have always wondered which version is the real one.",
  },
  {
    id: 'p-fired-daughter',
    topics: ['story', 'psychology', 'motivation', 'health'],
    text: "I was fired the week my daughter was born. I didn't tell my wife for nine days. I would get dressed, drive to a coffee shop, and sit there applying for jobs until six. And the reason I am telling you this is that the shame of it was so much heavier than the unemployment. The money we survived. The lying almost cost me the marriage.",
  },
  {
    id: 'p-ai-confidence',
    topics: ['ai', 'artificial intelligence', 'psychology'],
    text: "The thing that surprised me most about deploying these models at scale was not accuracy. It was that our users started trusting confident wrong answers more than hedged right ones. So we rebuilt the interface to expose uncertainty, and adoption dropped eleven percent. People say they want calibration. They buy confidence.",
  },
  {
    id: 'p-regulator-appendix',
    topics: ['ai', 'artificial intelligence', 'news', 'business'],
    text: "Last quarter the regulator published draft guidance, and buried in appendix C is the part that actually matters. Disclosure obligations attach at deployment, not at training. Which means every company that thought this was a model provider problem just became a deployer problem. Nobody is reading appendix C.",
  },
  {
    id: 'p-motivation-minimum',
    topics: ['mindset', 'motivation', 'productivity'],
    text: "Stop trying to be motivated. Motivation is a feeling, and you cannot schedule a feeling. What you can schedule is a starting time and a minimum. My minimum is one sentence. Some days I write one sentence. But I have never once written one sentence and then stopped.",
  },
  {
    id: 'p-risk-filter',
    topics: ['finance', 'business', 'mindset'],
    text: "Write this down. Never take advice about risk from someone who is not exposed to the outcome. That single filter would have saved me about four hundred thousand dollars and two years of my life.",
  },
  {
    id: 'p-designer-veto',
    topics: ['leadership', 'startup', 'business'],
    text: "We hired a designer from a company everyone admired, and she quit in five weeks. On her way out she told me our problem was not design, it was that eleven people could veto anything and nobody could approve anything. She was right. We removed the veto rights and shipped more in the following quarter than in the entire previous year.",
  },
  {
    id: 'p-tam-braver',
    topics: ['startup', 'finance', 'funny'],
    text: "An investor once told me our total market was too small, and then invested in a competitor eight months later at four times the price. Same market. Same size. I asked him about it and he said, and I quote, the market got bigger. It did not get bigger. He got braver.",
  },
  {
    id: 'p-content-three-jobs',
    topics: ['marketing', 'business', 'psychology'],
    text: "Every piece of content should do one of three jobs. Make someone feel seen, make someone feel smart, or make someone feel less alone. If it does none of those, it is information, and information is free. That is the whole game. People do not share what they learn. They share what confirms who they are.",
  },
  {
    id: 'p-son-movies',
    topics: ['health', 'story', 'motivation'],
    text: "The moment I knew I had to change was not a scan or a number. It was my son asking why I always fall asleep during movies. He was not complaining. He was curious. And that is somehow so much worse.",
  },
  {
    id: 'p-renting-optionality',
    topics: ['finance', 'controversial'],
    text: "Renting is not throwing money away and I am tired of pretending otherwise. You are buying optionality and liquidity, which are the two things that actually determine whether a bad year ruins you. Homeowners in a downturn have equity they cannot eat.",
  },
  {
    id: 'p-boundary-ultimatum',
    topics: ['psychology', 'mindset', 'leadership'],
    text: "There is a difference between a boundary and an ultimatum, and almost nobody gets taught it. A boundary is a statement about what you will do. An ultimatum is a statement about what they must do. I will leave the room if you shout, that is a boundary. You must stop shouting, that is an ultimatum. One you can keep. The other you can only enforce.",
  },
  {
    id: 'p-ai-agent-quit',
    topics: ['ai', 'artificial intelligence', 'leadership', 'story'],
    text: "We put the model in front of two hundred support agents and the first thing that happened was that the best agent on the team quit. Not because it threatened her job. Because it was suggesting the exact playbook she had spent six years developing, and management had never once asked her for it. That was the lesson. The technology did not devalue her expertise. It revealed that we already had it and had ignored it.",
  },
  {
    id: 'p-ai-moat-prompt',
    topics: ['ai', 'artificial intelligence', 'startup', 'business'],
    text: "The most expensive mistake in this field right now is building a product that assumes the model stays the same. Every roadmap I see is written as if today's capability is the ceiling. It is the floor. We rebuilt our entire evaluation stack three times in fourteen months, and the only thing that survived was the test set. Everything else, the prompts, the routing, the fine tunes, got thrown away. If your moat is a prompt, you do not have a moat. You have a temporary advantage and a very good marketing team.",
  },
  {
    id: 'p-ai-reviewers',
    topics: ['ai', 'artificial intelligence', 'leadership', 'business'],
    text: "We measured it. Our engineers using the assistant shipped forty percent more pull requests and spent sixty percent more time in code review. Nobody predicted the second number. It turns out that when writing is cheap, reading becomes the job. So we did something unpopular. We started paying reviewers more than authors. Everyone hated it for a quarter. Then defect rates fell by half.",
  },
  {
    id: 'p-startup-laundromat',
    topics: ['startup', 'business', 'story', 'leadership'],
    text: "Our first office was above a laundromat and the dryers ran until eleven at night. You could feel the floor vibrate. I used to think that was a hardship story I would tell later. It was not. The real story is that I made four people work there for two years, paid myself the same as them, and told them it was fair. It was not fair. They took equity risk I had already removed for myself. I have apologised to three of them. The fourth will not take my calls, and honestly, that is the right call.",
  },
  {
    id: 'p-startup-raise-deadline',
    topics: ['startup', 'finance', 'business'],
    text: "Everyone asks how much to raise. Wrong question. Ask what you are buying. A round is not money, it is a deadline with interest attached. If you raise three million you have just promised someone that in twenty four months this thing looks three times more inevitable than it does today. If you cannot name what makes it inevitable, you are not raising too little or too much. You are raising too early.",
  },
  {
    id: 'p-finance-house-fire',
    topics: ['finance', 'controversial', 'business'],
    text: "The index fund advice is correct and almost useless for the people who need advice most. If you have a stable salary and thirty years, then yes, buy the index and stop reading. But most people who ask me about money have irregular income, no emergency fund, and a debt at nineteen percent. Telling them about historical equity returns is like handing someone a treadmill while their house is on fire.",
  },
  {
    id: 'p-finance-recital',
    topics: ['finance', 'story', 'psychology'],
    text: "I lost eighty thousand dollars in eleven days, and the worst part was not the money. It was that I checked my phone during my daughter's recital. I remember the exact moment. She was halfway through her song, and I was looking at a red number. That is what leverage actually costs you. Not the drawdown. The attention.",
  },
  {
    id: 'p-marketing-stop-believing',
    topics: ['marketing', 'business', 'psychology'],
    text: "Here is the exercise that fixes most positioning. Write down what your customer would have to stop believing in order to buy from you. Not what they gain. What they abandon. Because every purchase is a small betrayal of a previous decision, and if you cannot name the belief you are asking someone to give up, your copy is talking past them. We did this and cut our messaging from eleven benefits down to one sentence. Conversion doubled.",
  },
  {
    id: 'p-marketing-identity',
    topics: ['marketing', 'psychology', 'business'],
    text: "Nobody shares content because it is useful. They share it because it makes them look like the kind of person who knows that. That is not cynical, it is just identity. So when we plan content now, the first question is not is this valuable. It is who does sharing this make you. If the answer is nobody in particular, it does not get made.",
  },
  {
    id: 'p-psych-resist-loss',
    topics: ['psychology', 'mindset', 'health'],
    text: "The single most useful thing I learned in fifteen years of clinical work is that people do not resist change, they resist loss. Every stuck patient I have ever had was protecting something. An identity, a relationship, a story about why it was not their fault. And the moment you name what they would lose by getting better, the resistance stops being irrational. It becomes a negotiation. And you can negotiate.",
  },
  {
    id: 'p-psych-rehearsal',
    topics: ['psychology', 'mindset', 'health'],
    text: "Anxiety is not a prediction, it is a rehearsal. Your brain is running a simulation and charging you the full emotional price of the outcome without any of the information. Once I started explaining it that way to patients, something shifted. You cannot argue with a prediction. But you can decline to rehearse.",
  },
  {
    id: 'p-health-friction',
    topics: ['health', 'productivity', 'leadership'],
    text: "Ninety percent of what I do is not medicine, it is removing friction. A patient who will not take a pill twice a day will take it once. A patient who will not come in monthly will come in quarterly. I used to think that was compromise. Now I think it is the entire job. The best treatment plan is not the optimal one. It is the one that survives contact with a real human life.",
  },
  {
    id: 'p-health-persons',
    topics: ['health', 'story', 'psychology'],
    text: "She was seventy three and she asked me whether the surgery was worth doing. And I gave her the statistics, because that is what we are trained to do. And she said, doctor, I did not ask what happens to a hundred people. I asked what happens to me. I have never forgotten it. We are very good at populations and very bad at persons.",
  },
  {
    id: 'p-leadership-standing',
    topics: ['leadership', 'business', 'productivity'],
    text: "The best manager I ever had did one thing differently. Every single week she told me, unprompted, exactly where I stood. Not feedback. Standing. You are solid, no concerns. Or, I am worried about the Anderson project. Four words, every week. I never once wondered whether I was in trouble, which meant I never once played politics. It is the cheapest thing a manager can do and almost nobody does it.",
  },
  {
    id: 'p-leadership-culture-deck',
    topics: ['leadership', 'controversial', 'business'],
    text: "Culture decks are a confession, not a description. If your values document says we communicate openly, I can tell you with real confidence that somebody senior is not communicating openly, and writing it down was cheaper than firing them. Read any company's stated values as a list of their unsolved problems and you will be right more often than the people who wrote it.",
  },
  {
    id: 'p-productivity-lying',
    topics: ['productivity', 'mindset', 'business'],
    text: "I stopped using a to do list two years ago and my output went up. Not because lists are bad. Because a list lets you feel productive while deciding nothing. Now everything goes on a calendar with a duration attached. If it does not fit, it does not happen, and I have to say that out loud to somebody. It turns out most of my productivity problem was actually a lying problem.",
  },
  {
    id: 'p-mindset-never-ready',
    topics: ['mindset', 'motivation', 'startup'],
    text: "You will never feel ready. I have started four companies and the feeling of readiness has arrived exactly zero times. What arrives instead is a deadline, or a person who is counting on you, or an amount of money running out. Readiness is a story we tell afterwards, once we already know it worked.",
  },
  {
    id: 'p-news-underwriters',
    topics: ['news', 'ai', 'artificial intelligence', 'finance'],
    text: "The thing that changed last month was not the technology, it was the insurance market. Two major carriers added exclusions for autonomous decision making. That single line does more to shape deployment than any regulation, because it moves the question from is this legal to will anyone underwrite it. Watch the underwriters, not the legislators.",
  },
  {
    id: 'p-funny-bigger-logo',
    topics: ['funny', 'marketing', 'business'],
    text: "We had a client who asked us to make the logo bigger, and then bigger, and then bigger, and at some point it was literally the entire homepage. [laughter] And here is the humiliating part. Conversion went up eleven percent. I have thought about that for six years. I have a design degree. He had a feeling. He was right.",
  },
];

/** Short conversational connective tissue between substantive passages. */
const BRIDGES: string[] = [
  'Right, that makes sense. Let me push on that a little bit though.',
  'Okay. So walk me through what happened next, because I think people miss this part.',
  'Yeah. And I want to come back to that in a second.',
  'Totally. Hmm. Can we stay on that for a moment?',
  'Sure, sure. And how long did that period last, roughly?',
  'That is a good point. I had not thought about it that way before.',
  'Let me read you something a listener sent in about exactly this.',
  'Okay, so zoom out for me. What does that mean practically?',
  'Interesting. And did anyone internally disagree with you at the time?',
  'Right. So then the obvious follow up is, what would you do differently?',
  'Mm. Yeah, I hear that a lot actually.',
  'Alright, last thing on this and then I want to change direction completely.',
];

/* -------------------------------------------------------------------------- */
/* Episodes                                                                   */
/* -------------------------------------------------------------------------- */

interface FixtureEpisodeSeed {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  tags: string[];
  topics: string[];
  daysAgo: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  /** Extra non-speech runtime: cold open, ads, outro. */
  paddingSec: number;
  /** Licensed CC BY, so clips are reusable with attribution. */
  creativeCommons?: boolean;
}

const EPISODE_SEEDS: FixtureEpisodeSeed[] = [
  {
    videoId: 'demo-ep-ai-judgment',
    channelId: 'demo-chan-signal',
    title: 'The Bottleneck Moved: AI, Judgment, and What Engineers Become Next',
    description:
      'A long conversation about what actually changes inside an engineering organisation when code gets cheap.\n\n00:00 Cold open\n02:15 Why "will AI replace programmers" is the wrong question\n14:40 Calibration versus confidence\n28:05 Appendix C and the deployer problem\n41:20 What the best support agent taught us\n52:10 Closing',
    tags: ['ai', 'artificial intelligence', 'engineering', 'technology', 'podcast'],
    creativeCommons: true,
    topics: ['ai', 'artificial intelligence', 'business', 'leadership'],
    daysAgo: 4,
    viewCount: 412_000,
    likeCount: 18_400,
    commentCount: 2_310,
    paddingSec: 900,
  },
  {
    videoId: 'demo-ep-founder-eighteen',
    channelId: 'demo-chan-founders',
    title: 'The Eighteen Months Nobody Warns You About | Founder Interview',
    description:
      'From eleven thousand dollars in the bank to a real business.\n\n00:00 Intro\n03:10 The parking lot\n17:45 Survivorship bias and bad advice\n31:00 Firing someone you like\n44:30 The veto problem',
    tags: ['startup', 'founders', 'entrepreneurship', 'business'],
    topics: ['startup', 'business', 'leadership', 'motivation'],
    daysAgo: 11,
    viewCount: 96_500,
    likeCount: 5_120,
    commentCount: 878,
    paddingSec: 720,
  },
  {
    videoId: 'demo-ep-capital-compound',
    channelId: 'demo-chan-capital',
    title: 'Compound Interest Is Oversold (And Other Things Finance Twitter Hates)',
    description:
      'A deliberately contrarian episode on income, optionality, and risk.\n\n00:00 Cold open\n04:00 Why compounding gets misused\n19:30 Renting versus owning\n33:15 Three questions before investing\n48:00 The risk filter',
    tags: ['finance', 'investing', 'money', 'economics'],
    topics: ['finance', 'business', 'controversial'],
    daysAgo: 6,
    viewCount: 1_240_000,
    likeCount: 52_900,
    commentCount: 9_840,
    paddingSec: 840,
  },
  {
    videoId: 'demo-ep-mind-resilience',
    channelId: 'demo-chan-mind',
    title: 'You Are More Resilient Than You Think: Adaptation, Shame, and Boundaries',
    description:
      'On hedonic adaptation, the shame of unemployment, and the difference between a boundary and an ultimatum.\n\n00:00 Intro\n05:20 The lottery study\n18:00 Nine days of lying\n34:40 Boundaries versus ultimatums',
    tags: ['psychology', 'mental health', 'resilience'],
    topics: ['psychology', 'mindset', 'health', 'story'],
    daysAgo: 19,
    viewCount: 318_000,
    likeCount: 21_700,
    commentCount: 3_120,
    paddingSec: 600,
  },
  {
    videoId: 'demo-ep-marketing-listening',
    channelId: 'demo-chan-signal',
    title: 'You Do Not Have a Positioning Problem, You Have a Listening Problem',
    description:
      'Marketing episode on customer belief, content that travels, and pricing.\n\n00:00 Cold open\n06:30 The one sentence test\n21:10 The three jobs of content\n35:50 Pricing basics',
    tags: ['marketing', 'growth', 'branding', 'content'],
    topics: ['marketing', 'business', 'psychology'],
    daysAgo: 27,
    viewCount: 187_000,
    likeCount: 9_800,
    commentCount: 1_140,
    paddingSec: 540,
  },
  {
    videoId: 'demo-ep-clinic-sleep',
    channelId: 'demo-chan-clinic',
    title: 'Stop Telling Exhausted People to Sleep More',
    description:
      'What actually moved adherence in our sleep clinic, and the moment a doctor changed his own habits.\n\n00:00 Intro\n07:00 Why the instruction fails\n22:30 Removing the thieves\n38:00 My son asked me a question',
    tags: ['health', 'sleep', 'medicine', 'habits'],
    creativeCommons: true,
    topics: ['health', 'productivity', 'story'],
    daysAgo: 2,
    viewCount: 143_000,
    likeCount: 11_200,
    commentCount: 1_890,
    paddingSec: 480,
  },
  {
    videoId: 'demo-ep-build-weird',
    channelId: 'demo-chan-build',
    title: 'The Feature That Only Worked If Your Name Was Short',
    description:
      'Shipping disasters, investor logic, and why focus is an inventory problem.\n\n00:00 Cold open\n04:40 Konstantina\n16:20 The market got bigger\n29:00 Forty open commitments',
    tags: ['startup', 'engineering', 'funny', 'product'],
    creativeCommons: true,
    topics: ['startup', 'funny', 'productivity', 'business'],
    daysAgo: 9,
    viewCount: 31_400,
    likeCount: 2_940,
    commentCount: 512,
    paddingSec: 420,
  },
  {
    videoId: 'demo-ep-capital-legacy',
    channelId: 'demo-chan-capital',
    title: 'Rich and Useless: What My Father Learned Selling Nine Years Late',
    description:
      'A quieter episode about time, ownership, and what you actually get to keep.\n\n00:00 Intro\n08:15 The offer he refused\n24:00 Before or after the wire cleared\n39:10 Motivation is not schedulable',
    tags: ['business', 'legacy', 'finance', 'story'],
    topics: ['business', 'story', 'finance', 'mindset'],
    daysAgo: 63,
    viewCount: 890_000,
    likeCount: 44_100,
    commentCount: 6_720,
    paddingSec: 660,
  },
  {
    videoId: 'demo-ep-signal-regulation',
    channelId: 'demo-chan-signal',
    title: 'Nobody Is Reading Appendix C',
    description:
      'The regulatory shift that moved liability from model providers to deployers.\n\n00:00 Cold open\n05:00 Appendix C\n17:30 Confidence versus calibration',
    tags: ['ai', 'artificial intelligence', 'policy', 'regulation', 'technology', 'news'],
    topics: ['ai', 'artificial intelligence', 'news'],
    daysAgo: 1,
    viewCount: 78_200,
    likeCount: 4_010,
    commentCount: 690,
    paddingSec: 360,
  },
  {
    videoId: 'demo-ep-founders-clarity',
    channelId: 'demo-chan-founders',
    title: 'Clarity Is the Kindest Thing You Have',
    description:
      'Hard conversations, veto culture, and the questions investors should be asking.\n\n00:00 Intro\n06:00 The firing I got wrong\n20:40 Eleven vetoes\n33:20 Three questions',
    tags: ['leadership', 'management', 'startup', 'hiring'],
    topics: ['leadership', 'business', 'startup'],
    daysAgo: 34,
    viewCount: 54_800,
    likeCount: 3_260,
    commentCount: 402,
    paddingSec: 480,
  },
  {
    videoId: 'demo-ep-mind-motivation',
    channelId: 'demo-chan-mind',
    title: 'Motivation Is a Feeling. You Cannot Schedule a Feeling.',
    description:
      'On minimums, inventory, and why discipline is usually a commitment problem.\n\n00:00 Cold open\n05:30 One sentence\n18:00 Forty commitments\n31:00 Adaptation',
    tags: ['mindset', 'productivity', 'motivation', 'habits'],
    topics: ['mindset', 'productivity', 'motivation', 'psychology'],
    daysAgo: 47,
    viewCount: 402_000,
    likeCount: 33_800,
    commentCount: 4_190,
    paddingSec: 540,
  },
  {
    videoId: 'demo-ep-clinic-short',
    channelId: 'demo-chan-clinic',
    title: 'Clinic Notes: A Six Minute Update',
    description: 'A short housekeeping update. Back to full episodes next week.',
    tags: ['health', 'update'],
    topics: ['health'],
    daysAgo: 3,
    viewCount: 8_400,
    likeCount: 410,
    commentCount: 38,
    paddingSec: 60,
  },
];

/* -------------------------------------------------------------------------- */
/* Deterministic transcript generation                                        */
/* -------------------------------------------------------------------------- */

/** FNV-1a. Small, stable, and dependency free. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const WORDS_PER_SECOND = 2.6;
const CUE_WORDS = 7;

const NOISE_PASSAGES = PASSAGES.filter((passage) => passage.topics.length === 0);
const SUBSTANTIVE_PASSAGES = PASSAGES.filter((passage) => passage.topics.length > 0);
const MAX_PASSAGES_PER_EPISODE = 6;

/**
 * Partition the substantive passages across episodes so each one belongs to
 * exactly one episode.
 *
 * Without this, every episode sharing a topic draws from the same pool and the
 * clip library fills with the same moment attributed to three different shows -
 * which reads as a bug rather than as demo data.
 *
 * Computed once at module load and fully deterministic.
 */
function buildPassageAssignment(): Map<string, FixturePassage[]> {
  const assignment = new Map<string, FixturePassage[]>(
    EPISODE_SEEDS.map((seed) => [seed.videoId, []]),
  );

  const claimed = new Set<string>();

  const overlap = (passage: FixturePassage, seed: FixtureEpisodeSeed): number =>
    passage.topics.filter((topic) => seed.topics.includes(topic)).length;

  /**
   * Round-robin draft. Each episode takes its best-fitting unclaimed passage in
   * turn, so allocation is both topically sensible (highest topic overlap wins)
   * and fair (no episode drafts twice before every other has drafted once).
   * A simple "assign each passage to a random matching episode" pass instead
   * left early episodes hogging the pool and later ones nearly empty.
   */
  for (let round = 0; round < MAX_PASSAGES_PER_EPISODE; round += 1) {
    for (const seed of EPISODE_SEEDS) {
      const bucket = assignment.get(seed.videoId)!;
      if (bucket.length > round) continue;

      const best = SUBSTANTIVE_PASSAGES.filter(
        (passage) => !claimed.has(passage.id) && overlap(passage, seed) > 0,
      ).sort((a, b) => {
        const byOverlap = overlap(b, seed) - overlap(a, seed);
        if (byOverlap !== 0) return byOverlap;
        return (
          hashString(`${seed.videoId}:${a.id}`) - hashString(`${seed.videoId}:${b.id}`)
        );
      })[0];

      if (!best) continue;
      bucket.push(best);
      claimed.add(best.id);
    }
  }

  // Stable ordering within each episode.
  for (const [videoId, bucket] of assignment) {
    bucket.sort(
      (a, b) => hashString(`${videoId}:${a.id}`) - hashString(`${videoId}:${b.id}`),
    );
  }

  return assignment;
}

const PASSAGE_ASSIGNMENT = buildPassageAssignment();

/**
 * Build the passage running order for an episode, interleaving sponsor reads and
 * filler at fixed positions so every episode contains material the scorer is
 * expected to reject.
 */
function selectPassages(seed: FixtureEpisodeSeed): FixturePassage[] {
  const assigned = PASSAGE_ASSIGNMENT.get(seed.videoId) ?? [];
  const result: FixturePassage[] = [];

  assigned.forEach((passage, index) => {
    result.push(passage);
    if (index === 1 || (index > 1 && index % 3 === 0)) {
      const pick = NOISE_PASSAGES[hashString(`${seed.videoId}:noise:${index}`) % NOISE_PASSAGES.length];
      if (pick) result.push(pick);
    }
  });

  return result;
}

function textToCues(text: string, startSec: number): { cues: TranscriptCue[]; endSec: number } {
  const words = text.split(/\s+/).filter(Boolean);
  const cues: TranscriptCue[] = [];
  let cursor = startSec;

  for (let i = 0; i < words.length; i += CUE_WORDS) {
    const chunk = words.slice(i, i + CUE_WORDS);
    const duration = chunk.length / WORDS_PER_SECOND;
    cues.push({
      startSec: Math.round(cursor * 100) / 100,
      endSec: Math.round((cursor + duration) * 100) / 100,
      text: chunk.join(' '),
    });
    cursor += duration;
  }

  return { cues, endSec: cursor };
}

function buildTranscript(seed: FixtureEpisodeSeed): Transcript {
  const passages = selectPassages(seed);
  const cues: TranscriptCue[] = [];

  // Cold open before the first substantive block.
  let cursor = 12;

  passages.forEach((passage, index) => {
    const bridge = BRIDGES[hashString(`${seed.videoId}:bridge:${index}`) % BRIDGES.length];
    if (index > 0 && bridge) {
      const bridgeResult = textToCues(bridge, cursor);
      cues.push(...bridgeResult.cues);
      cursor = bridgeResult.endSec + 0.6;
    }

    const result = textToCues(passage.text, cursor);
    cues.push(...result.cues);
    cursor = result.endSec + 1.2;
  });

  const wordCount = cues.reduce((total, cue) => total + cue.text.split(/\s+/).length, 0);

  return {
    videoId: seed.videoId,
    source: 'fixture',
    language: 'en',
    cues,
    durationSec: Math.round(cursor),
    wordCount,
  };
}

/** Cached so repeated calls in one process stay cheap and identical. */
const transcriptCache = new Map<string, Transcript>();

export function getFixtureTranscript(videoId: string): Transcript | null {
  const cached = transcriptCache.get(videoId);
  if (cached) return cached;

  const seed = EPISODE_SEEDS.find((episode) => episode.videoId === videoId);
  if (!seed) return null;

  const transcript = buildTranscript(seed);
  transcriptCache.set(videoId, transcript);
  return transcript;
}

/* -------------------------------------------------------------------------- */
/* Public fixture API (mirrors the live YouTube discovery surface)            */
/* -------------------------------------------------------------------------- */

function seedToCandidate(seed: FixtureEpisodeSeed, now: Date): EpisodeCandidate {
  const transcript = getFixtureTranscript(seed.videoId);
  const speechSeconds = transcript?.durationSec ?? 0;
  const publishedAt = new Date(now.getTime() - seed.daysAgo * 86_400_000).toISOString();
  const channel = FIXTURE_CHANNELS.find((item) => item.channelId === seed.channelId) ?? null;

  return {
    videoId: seed.videoId,
    title: seed.title,
    description: seed.description,
    channelId: seed.channelId,
    channelTitle: channel?.title ?? 'Unknown channel',
    publishedAt,
    durationSeconds: Math.round(speechSeconds + seed.paddingSec),
    viewCount: seed.viewCount,
    likeCount: seed.likeCount,
    commentCount: seed.commentCount,
    thumbnailUrl: null,
    tags: seed.tags,
    hasCaptions: true,
    // A minority of the demo catalogue is CC BY, mirroring reality, so the
    // licence filter has something to actually filter.
    license: seed.creativeCommons ? 'creativeCommon' : 'youtube',
    embeddable: true,
    channel,
  };
}

export function listFixtureChannels(): ChannelSummary[] {
  return [...FIXTURE_CHANNELS];
}

export function getFixtureChannel(channelId: string): ChannelSummary | null {
  return FIXTURE_CHANNELS.find((channel) => channel.channelId === channelId) ?? null;
}

/**
 * Topic search over the fixture catalogue. Ranking uses the same term coverage
 * helper as the real Episode Opportunity Score, so demo results are ordered by
 * the same notion of relevance as live results.
 */
/**
 * Format words the Discovery Agent appends to every query ("podcast", "full
 * episode", "interview"). They carry no topical meaning, and leaving them in
 * makes every episode look like a partial match for every topic.
 */
const QUERY_FORMAT_WORDS = new Set([
  'podcast', 'podcasts', 'episode', 'episodes', 'full', 'interview', 'interviews',
  'conversation', 'conversations', 'long', 'form', 'longform', 'show', 'clip',
  'clips', 'best', 'top', 'new', 'latest', '2024', '2025', '2026',
]);

function topicSignal(topic: string): string {
  return topic
    .split(/\s+/)
    .filter((word) => !QUERY_FORMAT_WORDS.has(word.toLowerCase().replace(/[^a-z0-9]/g, '')))
    .join(' ')
    .trim();
}

export function searchFixtureEpisodes(params: {
  topic: string;
  maxResults: number;
  publishedWithinDays?: number;
  now?: Date;
}): EpisodeCandidate[] {
  const now = params.now ?? new Date();
  const signal = topicSignal(params.topic) || params.topic;
  const scored = EPISODE_SEEDS.map((seed) => {
    const haystack = [seed.title, seed.description, seed.tags.join(' '), seed.topics.join(' ')].join(
      ' ',
    );
    return { seed, relevance: termCoverage(signal, haystack) };
  })
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.seed.daysAgo - b.seed.daysAgo);

  const filtered =
    typeof params.publishedWithinDays === 'number'
      ? scored.filter((entry) => entry.seed.daysAgo <= params.publishedWithinDays!)
      : scored;

  // An empty result would make demo mode look broken, so fall back to the most
  // recent episodes when a topic matches nothing in the catalogue.
  const source =
    filtered.length > 0
      ? filtered
      : [...EPISODE_SEEDS]
          .sort((a, b) => a.daysAgo - b.daysAgo)
          .map((seed) => ({ seed, relevance: 0 }));

  return source.slice(0, params.maxResults).map((entry) => seedToCandidate(entry.seed, now));
}

export function listFixtureChannelEpisodes(params: {
  channelId: string;
  maxResults: number;
  publishedWithinDays?: number;
  now?: Date;
}): EpisodeCandidate[] {
  const now = params.now ?? new Date();
  return EPISODE_SEEDS.filter((seed) => seed.channelId === params.channelId)
    .filter((seed) =>
      typeof params.publishedWithinDays === 'number'
        ? seed.daysAgo <= params.publishedWithinDays
        : true,
    )
    .sort((a, b) => a.daysAgo - b.daysAgo)
    .slice(0, params.maxResults)
    .map((seed) => seedToCandidate(seed, now));
}

export function fixtureChannelIds(): string[] {
  return FIXTURE_CHANNELS.map((channel) => channel.channelId);
}
