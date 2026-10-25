// Humanizer web server — Go standard library only.
//
// Serves the static UI, keeps conversations in memory, and proxies drafts to a
// local llama-server running jialinyyzz/humanizer, streaming the rewrite back
// to the browser as server-sent events.
//
// Model contract (see AGENTS.md in the Hugging Face repo):
//   - POST /completion with the exact prompt below, byte for byte
//   - temperature 1.0, top_p 0.95, top_k 0, min_p 0, repeat_penalty 1.0
//   - never send "stop"; generation ends at EOS
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// --- prompt contract -------------------------------------------------------

// instr is INSTR from prompt_format.json. Do not reword, translate or wrap it.
const instr = `Rewrite the text below so it reads like a person wrote it, not a language model.

Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,
throat-clearing, and any sentence that only announces what comes next.
Prefer the concrete word over the abstract one. It is fine to sound uneven.

Every fact, number, unit, date, name and quotation must survive unchanged.`

// sep is SEP from prompt_format.json.
const sep = "\n\n### Rewritten:\n\n"

// First 16 hex chars of sha256(buildPrompt("X")) as documented upstream.
const wantHash = "cc51d66b4c593fbe"

const (
	ctxLimit      = 8192 // llama-server is started with -c 8192
	maxDraftTok   = 7400 // leaves room for instr (~95) + a minimal rewrite
	instrTokSlack = 100
	maxAttempts   = 3 // docs: resample an English draft that came back in Chinese
)

func buildPrompt(draft string) string {
	return instr + "\n\n" + strings.TrimSpace(draft) + sep
}

// verifyPrompt fails loudly if the embedded prompt drifts from the model card.
func verifyPrompt() error {
	sum := sha256.Sum256([]byte(buildPrompt("X")))
	got := hex.EncodeToString(sum[:])[:16]
	if got != wantHash {
		return fmt.Errorf("prompt format check FAILED: got %s, want %s", got, wantHash)
	}
	return nil
}

// --- llama client ----------------------------------------------------------

type completionReq struct {
	Prompt        string  `json:"prompt"`
	Temperature   float64 `json:"temperature"`
	TopP          float64 `json:"top_p"`
	TopK          int     `json:"top_k"`
	MinP          float64 `json:"min_p"`
	RepeatPenalty float64 `json:"repeat_penalty"`
	NPredict      int     `json:"n_predict"`
	Stream        bool    `json:"stream"`
	CachePrompt   bool    `json:"cache_prompt"`
}

// sampleParams are the model's evaluation settings — all of them must be sent
// explicitly, llama-server's defaults differ from how the model was measured.
func sampleParams(prompt string, nPredict int) completionReq {
	return completionReq{
		Prompt:        prompt,
		Temperature:   1.0,
		TopP:          0.95,
		TopK:          0,   // off (llama default is 40)
		MinP:          0,   // off (llama default is 0.05)
		RepeatPenalty: 1.0, // off
		NPredict:      nPredict,
		Stream:        true,
		CachePrompt:   true, // retries re-send the identical prompt
	}
}

func nPredictFor(draftTokens int) int {
	n := int(2.5 * float64(draftTokens)) // the app's rule: ~2.5x the draft
	if n < 256 {
		n = 256
	}
	if n > 2048 {
		n = 2048
	}
	return n
}

// countTokens asks llama-server; falls back to a rough estimate if it can't.
func countTokens(ctx context.Context, text string) int {
	body, _ := json.Marshal(map[string]any{"content": text})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, llamaURL+"/tokenize", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		var r struct {
			Tokens []int `json:"tokens"`
		}
		if json.NewDecoder(resp.Body).Decode(&r) == nil && len(r.Tokens) > 0 {
			return len(r.Tokens)
		}
	}
	// ~3.5 runes per token is a fair mixed-language estimate
	n := len([]rune(text))
	return n*2/7 + 1
}

// streamCompletion calls /completion and reports every token as it arrives.
// Returns the full text once the run stops (EOS or n_predict).
func streamCompletion(ctx context.Context, prompt string, nPredict int, onToken func(string)) (string, error) {
	payload, err := json.Marshal(sampleParams(prompt, nPredict))
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, llamaURL+"/completion", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("llama-server unreachable (%v) — is it running? try ./run.sh", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := readLimited(resp.Body, 4096)
		return "", fmt.Errorf("llama-server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var sb strings.Builder
	sc := newJSONScanner(resp.Body)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		line = strings.TrimPrefix(line, "data: ") // tolerate SSE framing too
		var ev struct {
			Content string `json:"content"`
			Stop    bool   `json:"stop"`
		}
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		if ev.Content != "" {
			sb.WriteString(ev.Content)
			if onToken != nil {
				onToken(ev.Content)
			}
		}
		if ev.Stop {
			break
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() != nil {
			return sb.String(), ctx.Err()
		}
		return sb.String(), fmt.Errorf("stream interrupted: %v", err)
	}
	return sb.String(), nil
}

// --- output checks ---------------------------------------------------------

var (
	cjkRe      = regexp.MustCompile(`[\p{Han}]`)
	numRe      = regexp.MustCompile(`\d+`)
	badEchoSub = []string{"### Rewritten", "<start_of_turn>", "<end_of_turn>", "<|turn"}
)

// wantsRetry implements the model card's language check: an English draft that
// comes back mostly in Chinese gets sampled again, up to maxAttempts times.
func wantsRetry(draft, out string) bool {
	if len(cjkRe.FindString(draft)) > 0 {
		return false // draft itself contains Chinese — output is fine
	}
	cjk := len(cjkRe.FindAllString(out, -1))
	if cjk < 10 {
		return false // "a few" stray characters are not worth a resample
	}
	letters := 0
	for _, r := range out {
		if r > ' ' {
			letters++
		}
	}
	return letters > 0 && cjk*20 > letters // >5% Chinese
}

// promptEchoed catches wiring mistakes (wrong endpoint / chat template applied).
func promptEchoed(out string) string {
	for _, s := range badEchoSub {
		if strings.Contains(out, s) {
			return "output contains " + fmt.Sprintf("%q", s)
		}
	}
	if strings.HasPrefix(out, "Rewrite the text below") {
		return "output echoes the instruction"
	}
	return ""
}

// missingNumbers lists digits from the draft absent from the rewrite.
// Reported only — the model's output is never edited silently.
func missingNumbers(draft, out string) []string {
	seen := map[string]bool{}
	for _, n := range numRe.FindAllString(out, -1) {
		seen[n] = true
	}
	missing := []string{}
	for _, n := range numRe.FindAllString(draft, -1) {
		if !seen[n] && !containsString(missing, n) {
			missing = append(missing, n)
		}
	}
	sort.Slice(missing, func(i, j int) bool {
		a, _ := strconv.Atoi(missing[i])
		b, _ := strconv.Atoi(missing[j])
		if a != b {
			return a < b
		}
		return missing[i] < missing[j]
	})
	return missing
}

func containsString(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

// --- in-memory store -------------------------------------------------------

type Message struct {
	ID             string    `json:"id"`
	Draft          string    `json:"draft"`
	Result         string    `json:"result"`
	MissingNumbers []string  `json:"missingNumbers"`
	Retries        int       `json:"retries"`
	MS             int64     `json:"ms"`
	CreatedAt      time.Time `json:"createdAt"`
}

type Session struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Messages  []Message `json:"messages"`
}

type SessionSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Count     int       `json:"count"`
}

type store struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func newStore() *store { return &store{sessions: map[string]*Session{}} }

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return hex.EncodeToString(b)
}

func titleFor(draft string) string {
	t := strings.Join(strings.Fields(draft), " ")
	r := []rune(t)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return t
}

func (s *store) getOrCreate(id string) (sess Session, created bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != "" {
		if old, ok := s.sessions[id]; ok {
			cp := *old
			cp.Messages = append([]Message(nil), old.Messages...)
			return cp, false
		}
	}
	now := time.Now().UTC()
	ns := &Session{ID: newID(), Title: "Untitled", CreatedAt: now, UpdatedAt: now, Messages: []Message{}}
	s.sessions[ns.ID] = ns
	cp := *ns
	return cp, true
}

func (s *store) appendMessage(id string, m Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.sessions[id]; ok {
		old.Messages = append(old.Messages, m)
		old.UpdatedAt = m.CreatedAt
		if old.Title == "Untitled" || old.Title == "" {
			old.Title = titleFor(m.Draft)
		}
	}
}

func (s *store) list() []SessionSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]SessionSummary, 0, len(s.sessions))
	for _, v := range s.sessions {
		out = append(out, SessionSummary{
			ID: v.ID, Title: v.Title, CreatedAt: v.CreatedAt,
			UpdatedAt: v.UpdatedAt, Count: len(v.Messages),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

func (s *store) get(id string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	old, ok := s.sessions[id]
	if !ok {
		return Session{}, false
	}
	cp := *old
	cp.Messages = append([]Message(nil), old.Messages...)
	return cp, true
}

func (s *store) delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[id]; !ok {
		return false
	}
	delete(s.sessions, id)
	return true
}

// --- SSE -------------------------------------------------------------------

type sse struct {
	w http.ResponseWriter
	f http.Flusher
}

func newSSE(w http.ResponseWriter) (*sse, error) {
	f, ok := w.(http.Flusher)
	if !ok {
		return nil, errors.New("streaming unsupported")
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return &sse{w: w, f: f}, nil
}

func (s *sse) send(event string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.f.Flush()
}

// --- handlers --------------------------------------------------------------

var llamaURL string

func main() {
	addr := flag.String("addr", ":8090", "address for the web server")
	llamaURLFlag := flag.String("llama", "http://127.0.0.1:8080", "llama-server base URL")
	webDir := flag.String("web", "web", "directory with the static UI")
	flag.Parse()
	llamaURL = *llamaURLFlag

	if err := verifyPrompt(); err != nil {
		log.Fatalf("startup: %v", err)
	}
	log.Printf("prompt format OK (sha256 prefix %s)", wantHash)

	st := newStore()
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", handleHealth)
	mux.HandleFunc("POST /api/humanize", func(w http.ResponseWriter, r *http.Request) {
		handleHumanize(w, r, st)
	})
	mux.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": st.list()})
	})
	mux.HandleFunc("GET /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		sess, ok := st.get(r.PathValue("id"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such session"})
			return
		}
		writeJSON(w, http.StatusOK, sess)
	})
	mux.HandleFunc("DELETE /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !st.delete(r.PathValue("id")) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such session"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.Handle("GET /", http.FileServer(http.Dir(*webDir)))

	if _, err := os.Stat(*webDir); err != nil {
		log.Fatalf("startup: web dir %q not found: %v", *webDir, err)
	}

	log.Printf("humanizer UI on http://127.0.0.1%s", normalizeAddr(*addr))
	log.Printf("proxying to llama-server at %s", llamaURL)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	status := "down"
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, llamaURL+"/health", nil)
	if err == nil {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				status = "ok"
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "llama": status})
}

type humanizeReq struct {
	Draft     string `json:"draft"`
	SessionID string `json:"sessionId"`
}

func handleHumanize(w http.ResponseWriter, r *http.Request, st *store) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var req humanizeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad JSON: " + err.Error()})
		return
	}
	req.Draft = strings.TrimSpace(req.Draft)
	if req.Draft == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "empty draft"})
		return
	}

	prompt := buildPrompt(req.Draft)

	ctx := r.Context()
	draftTokens := countTokens(ctx, req.Draft)
	if draftTokens > maxDraftTok {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"error": fmt.Sprintf("draft is ~%d tokens; this server uses a %d-token context. Split the text.", draftTokens, ctxLimit),
		})
		return
	}
	nPredict := nPredictFor(draftTokens)
	if draftTokens+instrTokSlack+nPredict > ctxLimit {
		nPredict = ctxLimit - draftTokens - instrTokSlack
	}

	sess, _ := st.getOrCreate(req.SessionID)
	out, err := newSSE(w)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	out.send("meta", map[string]any{"sessionId": sess.ID, "attempt": 1, "draftTokens": draftTokens})

	var (
		text    string
		retries int
		started = time.Now()
	)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			out.send("retry", map[string]any{"attempt": attempt})
		}
		var sb strings.Builder
		text, err = streamCompletion(ctx, prompt, nPredict, func(tok string) {
			sb.WriteString(tok)
			out.send("token", map[string]any{"t": tok})
		})
		if err != nil {
			break
		}
		if !wantsRetry(req.Draft, text) {
			break
		}
		retries++
		log.Printf("session %s: English draft returned Chinese (attempt %d), resampling", sess.ID, attempt)
	}

	if err != nil {
		if errors.Is(err, context.Canceled) {
			log.Printf("session %s: client disconnected", sess.ID)
			return
		}
		out.send("error", map[string]any{"message": err.Error()})
		return
	}
	text = strings.TrimSpace(text)
	if why := promptEchoed(text); why != "" {
		out.send("error", map[string]any{"message": "bad model output (" + why + ")"})
		return
	}

	msg := Message{
		ID:             newID(),
		Draft:          req.Draft,
		Result:         text,
		MissingNumbers: missingNumbers(req.Draft, text),
		Retries:        retries,
		MS:             time.Since(started).Milliseconds(),
		CreatedAt:      time.Now().UTC(),
	}
	st.appendMessage(sess.ID, msg)

	out.send("done", map[string]any{
		"sessionId":      sess.ID,
		"messageId":      msg.ID,
		"attempts":       retries + 1,
		"retries":        retries,
		"missingNumbers": msg.MissingNumbers,
		"ms":             msg.MS,
		"draftTokens":    draftTokens,
		"text":           text,
	})
}

// --- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func normalizeAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return addr
	}
	return addr
}

func readLimited(r interface{ Read([]byte) (int, error) }, n int) ([]byte, error) {
	b := make([]byte, n)
	m, err := r.Read(b)
	return b[:m], err
}

// newJSONScanner reads NDJSON (or SSE) lines with room for a long token.
func newJSONScanner(r interface {
	Read([]byte) (int, error)
}) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return sc
}
