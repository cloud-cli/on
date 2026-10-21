package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const version = "0.1.0"
const maxResponse = 1 << 20

type Config struct {
	CoordinatorURL string   `json:"coordinatorUrl"`
	Credential     string   `json:"credential"`
	Tags           []string `json:"tags,omitempty"`
}

func validateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("coordinator URL must be an absolute URL without user info, query, or fragment")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, errors.New("coordinator URL must use HTTPS except on loopback")
	}
	return u, nil
}

func readConfig(path string) (Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return Config{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Config{}, err
	}
	if info.Mode().Perm()&0077 != 0 {
		return Config{}, errors.New("config file must not be accessible by group or other users")
	}
	b, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil {
		return Config{}, err
	}
	if len(b) > 64*1024 {
		return Config{}, errors.New("config file exceeds 64 KiB")
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if _, err := validateURL(c.CoordinatorURL); err != nil {
		return c, err
	}
	if strings.TrimSpace(c.Credential) == "" {
		return c, errors.New("credential is required")
	}
	return c, nil
}

func writeConfig(path string, c Config) error {
	if _, err := validateURL(c.CoordinatorURL); err != nil {
		return err
	}
	if strings.TrimSpace(c.Credential) == "" {
		return errors.New("credential is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".runner-credentials-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(append(b, '\n'))
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

type Client struct {
	base       *url.URL
	credential string
	http       *http.Client
}

func NewClient(raw, credential string) (*Client, error) {
	u, err := validateURL(raw)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(credential) == "" {
		return nil, errors.New("credential is required")
	}
	return &Client{base: u, credential: credential, http: &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}, nil
}
func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	u := *c.base
	u.Path = "/api/v1/" + strings.TrimLeft(path, "/")
	var r io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, 0, e
		}
		r = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), r)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.credential)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if len(b) > maxResponse {
		return nil, resp.StatusCode, errors.New("coordinator response exceeds 1 MiB")
	}
	if resp.StatusCode < 200 || (resp.StatusCode >= 300 && resp.StatusCode != 204) {
		return nil, resp.StatusCode, fmt.Errorf("coordinator returned HTTP %d", resp.StatusCode)
	}
	return b, resp.StatusCode, nil
}

type HeartbeatReport struct {
	Runtime      string   `json:"runtime"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
	Concurrency  int      `json:"concurrency"`
	ActiveJobs   int      `json:"activeJobs"`
}

func (c *Client) Heartbeat(ctx context.Context, report HeartbeatReport) error {
	if strings.TrimSpace(report.Runtime) == "" || strings.TrimSpace(report.Version) == "" || report.Concurrency < 1 || report.ActiveJobs < 0 {
		return errors.New("heartbeat requires runtime, version, positive concurrency, and non-negative active jobs")
	}
	_, _, err := c.request(ctx, http.MethodPost, "runner/heartbeat", report)
	return err
}

func (c *Client) Check(ctx context.Context) error {
	_, _, err := c.request(ctx, http.MethodGet, "runner/update", nil)
	return err
}

type Lease struct {
	LeaseID          string          `json:"leaseId"`
	LeaseToken       string          `json:"leaseToken"`
	ExpiresInSeconds int             `json:"expiresInSeconds"`
	Job              json.RawMessage `json:"job"`
	Workflow         json.RawMessage `json:"workflow"`
}

func (c *Client) Claim(ctx context.Context, tags []string) (*Lease, error) {
	b, status, e := c.request(ctx, http.MethodPost, "runner/leases", map[string]any{"tags": tags})
	if e != nil {
		return nil, e
	}
	if status == 204 {
		return nil, nil
	}
	var l Lease
	if e = json.Unmarshal(b, &l); e != nil {
		return nil, e
	}
	if l.LeaseID == "" || l.LeaseToken == "" || len(l.Job) == 0 || len(l.Workflow) == 0 {
		return nil, errors.New("coordinator returned an incomplete lease")
	}
	return &l, nil
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "doctor":
		fs := flag.NewFlagSet("doctor", flag.ExitOnError)
		cfg := fs.String("config", "runner.json", "credentials/config file")
		_ = fs.Parse(os.Args[2:])
		c, e := readConfig(*cfg)
		if e != nil {
			fmt.Fprintln(os.Stderr, "config:", e)
			os.Exit(1)
		}
		cl, e := NewClient(c.CoordinatorURL, c.Credential)
		if e == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			e = cl.Check(ctx)
		}
		if e != nil {
			fmt.Fprintln(os.Stderr, "coordinator check failed:", e)
			os.Exit(1)
		}
		fmt.Println("Coordinator reachable; no jobs claimed.")
	default:
		usage()
		os.Exit(2)
	}
}
func usage() { fmt.Fprintln(os.Stderr, "usage: on-runner version | doctor [-config path]") }
