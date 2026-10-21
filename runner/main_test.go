package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestURLSecurity(t *testing.T) {
	for _, tc := range []struct {
		url string
		ok  bool
	}{{"https://runner.example", true}, {"http://localhost:3000", true}, {"http://example.com", false}, {"ftp://localhost", false}} {
		_, e := validateURL(tc.url)
		if (e == nil) != tc.ok {
			t.Fatalf("%s err=%v", tc.url, e)
		}
	}
}

func TestCredentialsPrivateAndReadable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "credentials.json")
	c := Config{CoordinatorURL: "https://coordinator.example", Credential: "secret"}
	if e := writeConfig(p, c); e != nil {
		t.Fatal(e)
	}
	got, e := readConfig(p)
	if e != nil || got.Credential != c.Credential {
		t.Fatalf("%+v %v", got, e)
	}
	i, e := os.Stat(p)
	if e != nil {
		t.Fatal(e)
	}
	if i.Mode().Perm() != 0600 {
		t.Fatalf("permissions %o", i.Mode().Perm())
	}
}

func TestReadConfigRejectsPermissiveFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(p, []byte(`{"coordinatorUrl":"https://runner.example","credential":"secret"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(p); err == nil {
		t.Fatal("expected permissive credential file to be rejected")
	}
}

func TestAPIHeartbeatClaimAndIdle(t *testing.T) {
	var seenHeartbeat, seenClaim bool
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("missing bearer")
		}
		switch r.URL.Path {
		case "/api/v1/runner/heartbeat":
			seenHeartbeat = true
			if r.Method != "POST" {
				t.Error(r.Method)
			}
			w.WriteHeader(204)
		case "/api/v1/runner/leases":
			seenClaim = true
			if r.Method != "POST" {
				t.Error(r.Method)
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["tags"] == nil {
				t.Error("missing tags")
			}
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	}))
	defer s.Close()
	c, e := NewClient(s.URL, "token")
	if e != nil {
		t.Fatal(e)
	}
	if e = c.Heartbeat(context.Background(), HeartbeatReport{
		Runtime: "go", Version: version, Capabilities: []string{"linux"}, Concurrency: 1,
	}); e != nil {
		t.Fatal(e)
	}
	l, e := c.Claim(context.Background(), []string{"linux"})
	if e != nil || l != nil {
		t.Fatalf("lease=%v error=%v", l, e)
	}
	if !seenHeartbeat || !seenClaim {
		t.Fatal("endpoint not called")
	}
}

func TestDoctorCheckIsReadOnly(t *testing.T) {
	called := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/runner/update" {
			t.Errorf("doctor made unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"update":null}`))
	}))
	defer s.Close()
	c, err := NewClient(s.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("doctor endpoint not called")
	}
}

func TestClaimDecodesLeaseToken(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/runner/leases" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"leaseId":"l1","leaseToken":"lt","expiresInSeconds":90,"job":{"id":1},"workflow":{}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer s.Close()
	c, _ := NewClient(s.URL, "token")
	l, e := c.Claim(context.Background(), nil)
	if e != nil || l == nil || l.LeaseID != "l1" {
		t.Fatalf("%+v %v", l, e)
	}
	if l.LeaseToken != "lt" {
		t.Fatal("lease token not decoded")
	}
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	called := false
	collector := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer collector.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", collector.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	client, err := NewClient(redirect.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Check(context.Background()); err == nil {
		t.Fatal("expected redirect response to be rejected")
	}
	if called {
		t.Fatal("authenticated request followed a redirect")
	}
}
