import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const FALLBACK_RESPONSE_FILE = path.join(process.cwd(), "response.md");

type QuestionKind = "single" | "multiple" | "text";

interface ExtractedQuestion {
	id: string;
	question: string;
	kind: QuestionKind;
	options: string[];
}

interface CardState {
	id: string;
	question: string;
	kind: QuestionKind;
	options: string[];
	selected: Set<number>;
	textAnswer: string;
	optionCursor: number;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const EXTRACTION_PROMPT = `Extract questions from the assistant response.

Return strict JSON only in this shape:
{
  "questions": [
    {
      "id": "q1",
      "question": "Question text",
      "kind": "single|multiple|text",
      "options": ["optional", "options"]
    }
  ]
}

Rules:
- Find each question the assistant asks the user to answer.
- Use "single" when exactly one option should be chosen.
- Use "multiple" when multiple options may be chosen.
- Use "text" when the answer should be typed freely.
- Preserve option text when present in bullets or lists under a question.
- If uncertain, prefer "text".
- Do not include any commentary or markdown.`;

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("```")) {
		return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	}
	return trimmed;
}

function safeJsonParse(text: string): ExtractionResult | null {
	const raw = stripCodeFences(text);
	try {
		const parsed = JSON.parse(raw) as ExtractionResult;
		if (!parsed || !Array.isArray(parsed.questions)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isQuestionLine(line: string): boolean {
	return /\?$/.test(line.trim()) && line.trim().length > 2;
}

function isBulletLine(line: string): boolean {
	return /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
}

function cleanBullet(line: string): string {
	return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
}

function inferKind(question: string, options: string[]): QuestionKind {
	const q = question.toLowerCase();
	if (options.length === 0) return "text";

	if (/(select all|all that apply|multiple|any of|choose all|toggle|pick many)/.test(q)) {
		return "multiple";
	}
	if (/(choose one|select one|single|which one|one of|either)/.test(q)) {
		return "single";
	}

	if (options.length >= 4) return "multiple";
	if (options.length === 3) return /\bwhat\b|\bhow\b|\bshould\b|\bcan\b/.test(q) ? "multiple" : "single";
	if (options.length === 2) return /\bor\b|\bvs\b|\beither\b/.test(q) ? "single" : "multiple";

	return "text";
}

function parseAssistantText(text: string): ExtractedQuestion[] {
	const lines = text.split(/\r?\n/);
	const questions: ExtractedQuestion[] = [];
	let current: { question: string; options: string[] } | null = null;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;

		if (isQuestionLine(line)) {
			if (current) {
				questions.push({
					id: `q${questions.length + 1}`,
					question: current.question,
					kind: inferKind(current.question, current.options),
					options: current.options,
				});
			}
			current = { question: line, options: [] };
			continue;
		}

		if (current && isBulletLine(line)) {
			current.options.push(cleanBullet(line));
		}
	}

	if (current) {
		questions.push({
			id: `q${questions.length + 1}`,
			question: current.question,
			kind: inferKind(current.question, current.options),
			options: current.options,
		});
	}

	return questions;
}

function formatSummary(cards: CardState[]): string {
	return cards
		.map((card, idx) => {
			const header = `${idx + 1}. ${card.question}`;
			if (card.kind === "text") {
				return `${header}\n   Selected / provided answer: ${card.textAnswer.trim() || "(not provided)"}`;
			}

			const selected = Array.from(card.selected)
				.sort((a, b) => a - b)
				.map((i) => card.options[i])
				.filter(Boolean);
			return `${header}\n   Selected / provided answer: ${selected.length ? selected.join(", ") : "(not selected)"}`;
		})
		.join("\n\n");
}

function getLastAssistantTextFromSession(ctx: any): string | null {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason && msg.stopReason !== "stop") continue;

		const text = (msg.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return null;
}

function getInputTextFallback(): string | null {
	if (!fs.existsSync(FALLBACK_RESPONSE_FILE)) return null;
	const text = fs.readFileSync(FALLBACK_RESPONSE_FILE, "utf8").trim();
	return text || null;
}

class QuestionCardForm {
	private cards: CardState[];
	private active = 0;
	private editingText = false;
	private editor: Editor;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	public onSubmit?: (text: string) => void;
	public onCancel?: () => void;

	constructor(private tui: any, private theme: any, extracted: ExtractedQuestion[]) {
		this.cards = extracted.map((q) => ({
			id: q.id,
			question: q.question,
			kind: q.kind,
			options: q.options,
			selected: new Set<number>(),
			textAnswer: "",
			optionCursor: 0,
		}));

		this.editor = new Editor(tui, {
			borderColor: (s: string) => this.theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => this.theme.fg("accent", t),
				selectedText: (t: string) => this.theme.fg("accent", t),
				description: (t: string) => this.theme.fg("muted", t),
				scrollInfo: (t: string) => this.theme.fg("dim", t),
				noMatch: (t: string) => this.theme.fg("warning", t),
			},
		});
		this.editor.onSubmit = (value) => {
			const card = this.cards[this.active];
			if (!card) return;
			card.textAnswer = value.trim();
			this.editingText = false;
			this.editor.setText(card.textAnswer);
			this.invalidate();
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.editingText;
	}

	private current(): CardState | undefined {
		return this.cards[this.active];
	}

	private allAnswered(): boolean {
		return this.cards.every((card) => {
			if (card.kind === "text") return card.textAnswer.trim().length > 0;
			return card.selected.size > 0;
		});
	}

	private setKind(kind: QuestionKind): void {
		const card = this.current();
		if (!card) return;
		card.kind = kind;
		if (kind === "text") {
			card.selected.clear();
			this.editor.setText(card.textAnswer);
		} else {
			card.optionCursor = Math.min(card.optionCursor, Math.max(0, card.options.length - 1));
			if (kind === "single" && card.selected.size > 1) {
				const first = Array.from(card.selected)[0];
				card.selected = new Set(first !== undefined ? [first] : []);
			}
		}
		this.invalidate();
	}

	private chooseOption(idx: number): void {
		const card = this.current();
		if (!card || idx < 0 || idx >= card.options.length) return;

		card.optionCursor = idx;
		if (card.kind === "single") {
			card.selected = new Set([idx]);
		} else if (card.kind === "multiple") {
			if (card.selected.has(idx)) card.selected.delete(idx);
			else card.selected.add(idx);
		}
		this.invalidate();
	}

	private clearCurrent(): void {
		const card = this.current();
		if (!card) return;
		card.selected.clear();
		card.textAnswer = "";
		this.editor.setText("");
		this.invalidate();
	}

	private move(delta: number): void {
		if (!this.cards.length) return;
		this.active = (this.active + delta + this.cards.length) % this.cards.length;
		const card = this.current();
		if (card && card.kind === "text") {
			this.editor.setText(card.textAnswer);
		}
		if (card && card.kind !== "text") {
			card.optionCursor = Math.min(card.optionCursor, Math.max(0, card.options.length - 1));
		}
		this.editingText = false;
		this.editor.focused = false;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (this.editingText) {
			if (matchesKey(data, Key.escape)) {
				this.editingText = false;
				const card = this.current();
				this.editor.setText(card?.textAnswer ?? "");
				this.editor.focused = false;
				this.invalidate();
				return;
			}
			this.editor.handleInput(data);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.move(1);
			return;
		}

		const card = this.current();
		if (matchesKey(data, Key.up)) {
			if (!card) return;
			if (card.kind === "text") {
				this.move(-1);
				return;
			}
			if (card.options.length > 0) {
				card.optionCursor = (card.optionCursor - 1 + card.options.length) % card.options.length;
				this.invalidate();
				return;
			}
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (!card) return;
			if (card.kind === "text") {
				this.move(1);
				return;
			}
			if (card.options.length > 0) {
				card.optionCursor = (card.optionCursor + 1) % card.options.length;
				this.invalidate();
				return;
			}
			this.move(1);
			return;
		}

		if (!card) {
			if (matchesKey(data, Key.escape)) this.onCancel?.();
			return;
		}

		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.onCancel?.();
			return;
		}

		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || data === "c") {
			this.clearCurrent();
			return;
		}

		if (data === "1") {
			this.setKind("single");
			return;
		}
		if (data === "2") {
			this.setKind("multiple");
			return;
		}
		if (data === "3") {
			this.setKind("text");
			return;
		}

		if (data === "e") {
			this.editingText = true;
			this.editor.setText(card.textAnswer);
			this.editor.focused = true;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (card.kind === "text" || card.options.length === 0) {
				if (card.textAnswer.trim().length === 0) {
					this.editingText = true;
					this.editor.setText(card.textAnswer);
					this.editor.focused = true;
					this.invalidate();
					return;
				}
				if (this.allAnswered()) {
					this.onSubmit?.(formatSummary(this.cards));
					return;
				}
				this.editingText = true;
				this.editor.setText(card.textAnswer);
				this.editor.focused = true;
				this.invalidate();
				return;
			}

			this.chooseOption(card.optionCursor);
			return;
		}

		if (/^[1-9]$/.test(data)) {
			const optionIndex = Number(data) - 1;
			if (Number.isFinite(optionIndex)) {
				this.chooseOption(optionIndex);
				return;
			}
		}

		if (data === "s" && this.allAnswered()) {
			this.onSubmit?.(formatSummary(this.cards));
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const card = this.current();
		const title = `Question cards • ${this.active + 1}/${this.cards.length}`;
		lines.push(truncateToWidth(this.theme.fg("accent", title), width));

		const status = this.cards
			.map((c, i) => {
				const mark = c.kind === "text" ? (c.textAnswer.trim() ? "✓" : "○") : c.selected.size ? "✓" : "○";
				const label = `${i + 1}${mark}`;
				return i === this.active ? this.theme.bg("selectedBg", this.theme.fg("text", ` ${label} `)) : this.theme.fg("muted", ` ${label} `);
			})
			.join("");
		lines.push(truncateToWidth(status, width));
		lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ move option • Enter choose • 1/2/3 type • e edit • s submit when done • Esc cancel • C clear"), width));
		lines.push("");

		if (!card) {
			lines.push(truncateToWidth(this.theme.fg("warning", "No questions found."), width));
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const border = this.theme.fg("accent", "─".repeat(Math.max(0, width)));
		lines.push(truncateToWidth(border, width));
		lines.push(truncateToWidth(this.theme.fg("accent", ` ${card.question}`), width));
		lines.push(truncateToWidth(this.theme.fg("muted", ` Type: ${card.kind}`), width));
		lines.push("");

		if (card.kind === "text") {
			if (this.editingText) {
				lines.push(truncateToWidth(this.theme.fg("accent", " Your answer:"), width));
				for (const row of this.editor.render(Math.max(8, width - 2))) {
					lines.push(truncateToWidth(` ${row}`, width));
				}
			} else {
				const answer = card.textAnswer.trim() || "(press Enter to type an answer)";
				for (const row of wrapTextWithAnsi(this.theme.fg("text", ` Answer: ${answer}`), width)) {
					lines.push(truncateToWidth(row, width));
				}
			}
		} else {
			const selected = Array.from(card.selected)
				.sort((a, b) => a - b)
				.map((i) => card.options[i])
				.filter(Boolean);
			lines.push(truncateToWidth(this.theme.fg("muted", ` Selected: ${selected.length ? selected.join(", ") : "(none)"}`), width));
			lines.push("");
			for (let i = 0; i < card.options.length; i++) {
				const checked = card.kind === "single" ? (card.selected.has(i) ? "(x)" : "( )") : card.selected.has(i) ? "[x]" : "[ ]";
				const row = `${i + 1}. ${checked} ${card.options[i]}`;
				const rendered = i === card.optionCursor ? this.theme.bg("selectedBg", this.theme.fg("text", row)) : row;
				for (const wrapped of wrapTextWithAnsi(rendered, width)) {
					lines.push(truncateToWidth(wrapped, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", this.allAnswered() ? "Press Enter to build the response." : "Fill all cards before submitting."), width));
		lines.push(truncateToWidth(border, width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function questionCardFormExtension(pi: ExtensionAPI) {
	pi.registerCommand("question-cards", {
		description: "Extract the previous assistant response into a card form and build a structured answer summary",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("This command requires interactive UI.", "error");
				return;
			}

			const assistantText = getLastAssistantTextFromSession(ctx) ?? getInputTextFallback();
			if (!assistantText) {
				ctx.ui.notify("No previous assistant response found.", "error");
				return;
			}

			let extracted: ExtractedQuestion[] = [];
			if (ctx.model) {
				try {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
					if (auth.ok && auth.apiKey) {
						const userMessage: UserMessage = {
							role: "user",
							content: [{ type: "text", text: assistantText }],
							timestamp: Date.now(),
						};

						const response = await complete(
							ctx.model,
							{ systemPrompt: EXTRACTION_PROMPT, messages: [userMessage] },
							{ apiKey: auth.apiKey, headers: auth.headers },
						);

						const text = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						const parsed = safeJsonParse(text);
						if (parsed?.questions?.length) {
							extracted = parsed.questions.map((q, i) => ({
								id: q.id || `q${i + 1}`,
								question: q.question,
								kind: q.kind === "single" || q.kind === "multiple" || q.kind === "text" ? q.kind : "text",
								options: Array.isArray(q.options) ? q.options : [],
							}));
						}
					}
				} catch {
					// fall back to heuristic parsing below
				}
			}

			if (extracted.length === 0) {
				extracted = parseAssistantText(assistantText);
			}

			if (extracted.length === 0) {
				ctx.ui.notify("No questions detected in the previous response.", "warning");
				return;
			}

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const component = new QuestionCardForm(tui, theme, extracted);
				component.onSubmit = (text) => done(text);
				component.onCancel = () => done(null);
				return component;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Response built in editor.", "info");
		},
	});
}
