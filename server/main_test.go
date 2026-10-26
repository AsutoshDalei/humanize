package main

import (
	"strings"
	"testing"
)

// The contamination guard must catch a response carrying another draft's text,
// and must stay quiet for the same draft resubmitted.
func TestForeignHead(t *testing.T) {
	draftA := "The ZQXJ7 velocimeter report shows 812 units were shipped to Ostrava " +
		"before the quorum adjourned, leaving forty-four unaccounted crates in " +
		"the north vestibule under Marcus's supervision."
	draftB := "Brenda's K49 frost survey describes twelve terraced orchards above the " +
		"Kellerman ridge where an early freeze delayed the second harvest by nine days."

	rememberDraft("sess-1", draftA)
	rememberDraft("sess-2", draftB)

	// a response built from draft B that smuggles in a run from draft A
	contaminated := "Brenda's survey says the fruit is fine. " + normHead(draftA) +
		" and that is how the crates went missing."
	if got := foreignHead(draftB, contaminated); got == "" {
		t.Fatal("foreignHead missed a verbatim run from another draft")
	}

	// a normal rewrite of draft B contains its own opening — not contamination
	clean := normHead(draftB) + " rewritten in a plainer register."
	if got := foreignHead(draftB, clean); got != "" {
		t.Errorf("foreignHead flagged the draft's own text: %q", got)
	}

	// the same draft resubmitted in a fresh session is not foreign either
	if got := foreignHead(draftA, normHead(draftA)+" then continued."); got != "" {
		t.Errorf("foreignHead flagged a resubmitted identical draft: %q", got)
	}
}

// Short drafts have no signature, so they can never cause a false positive.
func TestForeignHeadIgnoresShortDrafts(t *testing.T) {
	rememberDraft("sess-short", "Too short to matter.")
	if got := foreignHead("something else entirely", "another different text"); got != "" {
		t.Errorf("short draft produced a signature: %q", got)
	}
}

func TestOverrun(t *testing.T) {
	draft := strings.Repeat("the report was late and nobody noticed for weeks. ", 20) // ~980 chars
	if overrun(draft, draft+" A sentence.") {
		t.Error("a normal-length rewrite was flagged as overrun")
	}
	if !overrun(draft, draft+strings.Repeat("unrelated appended material ", 80)) {
		t.Error("an appended block was not flagged as overrun")
	}
}

// The prompt format is the model contract; a drift must fail loudly.
func TestPromptFormat(t *testing.T) {
	if err := verifyPrompt(); err != nil {
		t.Fatal(err)
	}
}
