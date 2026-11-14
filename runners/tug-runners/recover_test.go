package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeActions is GitHub's Actions API for a few repositories: their runs, each run's jobs, and an organization's
// repositories. It records every request, and a cancelled run reports completed once cancelled.
type fakeActions struct {
	mu        sync.Mutex
	requests  []string
	runs      map[string][]map[string]any // by repository
	jobs      map[int64][]map[string]any  // by run
	orgRepos  []map[string]any
	cancelled map[int64]bool
	stopping  bool // a cancelled run never reports completed
}

func (f *fakeActions) serve(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_x" {
			http.Error(w, "Bad credentials", http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		switch {
		case r.Method == http.MethodGet && len(parts) == 3 && parts[0] == "orgs" && parts[2] == "repos":
			_ = json.NewEncoder(w).Encode(f.orgRepos)
		case r.Method == http.MethodGet && len(parts) == 5 && parts[3] == "actions" && parts[4] == "runs":
			if !strings.HasPrefix(r.URL.Query().Get("created"), ">=") {
				http.Error(w, "the sweep reads only recent runs", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"workflow_runs": f.runs[parts[1]+"/"+parts[2]]})
		case r.Method == http.MethodGet && len(parts) == 7 && parts[6] == "jobs":
			_ = json.NewEncoder(w).Encode(map[string]any{"jobs": f.jobs[runID(parts[5])]})
		case r.Method == http.MethodGet && len(parts) == 6 && parts[4] == "runs":
			status := "queued"
			if f.cancelled[runID(parts[5])] && !f.stopping {
				status = "completed"
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
		case r.Method == http.MethodPost && len(parts) == 7 && parts[6] == "cancel":
			f.cancelled[runID(parts[5])] = true
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodPost && len(parts) == 7 && parts[6] == "rerun-failed-jobs":
			w.WriteHeader(http.StatusCreated)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	previous := apiBase
	apiBase = server.URL
	t.Cleanup(func() { apiBase = previous })
}

func runID(s string) int64 {
	id, _ := strconv.ParseInt(s, 10, 64)
	return id
}

func (f *fakeActions) writes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.DeleteFunc(slices.Clone(f.requests), func(r string) bool { return !strings.HasPrefix(r, "POST ") })
}

func sweepPool(max, running int) *pool {
	p := testPool(max)
	p.cfg.token, p.cfg.label, p.running = "ghp_x", "tug", running
	return p
}

func TestSweepQueuesAgainAJobNoRunnerWasToldOf(t *testing.T) {
	now := time.Now()
	job := func(name, status string, labels []string, age time.Duration) map[string]any {
		return map[string]any{"name": name, "status": status, "labels": labels, "created_at": now.Add(-age).Format(time.RFC3339)}
	}
	f := &fakeActions{
		cancelled: map[int64]bool{},
		runs: map[string][]map[string]any{"octocat/app": {
			{"id": 1, "status": "queued"},      // stuck: queued past stuckAfter for the label
			{"id": 2, "status": "completed"},   // done
			{"id": 3, "status": "in_progress"}, // a job of it runs, which a cancel would stop
			{"id": 4, "status": "queued"},      // queued a minute ago, so it may yet start
			{"id": 5, "status": "queued"},      // waits for another label
		}},
		jobs: map[int64][]map[string]any{
			1: {job("test", "completed", []string{"tug"}, time.Hour), job("review / code and security", "queued", []string{"tug"}, 10*time.Minute)},
			3: {job("test", "in_progress", []string{"tug"}, 10*time.Minute), job("review", "queued", []string{"tug"}, 10*time.Minute)},
			4: {job("review", "queued", []string{"tug"}, time.Minute)},
			5: {job("build", "queued", []string{"ubuntu-latest"}, time.Hour)},
		},
	}
	f.serve(t)
	s := sweepPool(2, 1).addScaler("https://github.com/octocat/app")

	n, err := s.sweep(context.Background(), now)
	if err != nil || n != 1 {
		t.Fatalf("want 1 run queued again, got %d, %v", n, err)
	}
	if got, want := f.writes(), []string{"POST /repos/octocat/app/actions/runs/1/cancel", "POST /repos/octocat/app/actions/runs/1/rerun-failed-jobs"}; !slices.Equal(got, want) {
		t.Fatalf("writes %v, want %v", got, want)
	}
	// The re-run waited for the cancelled run to stop.
	f.mu.Lock()
	defer f.mu.Unlock()
	cancel := slices.Index(f.requests, "POST /repos/octocat/app/actions/runs/1/cancel")
	if !slices.Contains(f.requests[cancel:], "GET /repos/octocat/app/actions/runs/1") {
		t.Fatalf("re-ran without reading the run's status: %v", f.requests)
	}
}

func TestSweepWaitsWhileEverySlotIsBusy(t *testing.T) {
	f := &fakeActions{cancelled: map[int64]bool{}}
	f.serve(t)
	s := sweepPool(2, 2).addScaler("https://github.com/octocat/app")
	if n, err := s.sweep(context.Background(), time.Now()); n != 0 || err != nil {
		t.Fatalf("got %d, %v", n, err)
	}
	if len(f.requests) != 0 {
		t.Fatalf("a full pool still read GitHub: %v", f.requests)
	}
}

func TestSweepReadsOnlyAnOrganizationsRecentRepositories(t *testing.T) {
	now := time.Now()
	f := &fakeActions{
		cancelled: map[int64]bool{},
		orgRepos: []map[string]any{
			{"full_name": "acme/recent", "pushed_at": now.Add(-time.Hour).Format(time.RFC3339)},
			{"full_name": "acme/old", "pushed_at": now.Add(-48 * time.Hour).Format(time.RFC3339)},
			{"full_name": "acme/archived", "archived": true, "pushed_at": now.Add(-time.Hour).Format(time.RFC3339)},
		},
		runs: map[string][]map[string]any{},
	}
	f.serve(t)
	s := sweepPool(2, 0).addScaler("https://github.com/acme")
	if _, err := s.sweep(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if got, want := f.requests, []string{"GET /orgs/acme/repos", "GET /repos/acme/recent/actions/runs"}; !slices.Equal(got, want) {
		t.Fatalf("requests %v, want %v", got, want)
	}
}

func TestRequeueNeverReRunsARunThatDidNotStop(t *testing.T) {
	previousPoll, previousTries := requeuePoll, requeueTries
	requeuePoll, requeueTries = time.Millisecond, 3
	defer func() { requeuePoll, requeueTries = previousPoll, previousTries }()
	f := &fakeActions{cancelled: map[int64]bool{}, stopping: true}
	f.serve(t)
	if err := requeue(context.Background(), "ghp_x", "octocat/app", 7); err == nil {
		t.Fatal("want an error when the run never stops")
	}
	if got := f.writes(); !slices.Equal(got, []string{"POST /repos/octocat/app/actions/runs/7/cancel"}) {
		t.Fatalf("writes %v", got)
	}
}
