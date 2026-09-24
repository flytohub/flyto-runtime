// The app's executable. Runtime is a terminal program, so this only opens
// Terminal on the Runtime launcher inside the bundle and exits.
//
// Terminal is pointed at a one-line script this process writes into the
// user's own folder. A file this app creates carries no quarantine, so
// Terminal runs it without a second Gatekeeper prompt; the bundle's own
// .command file would still carry the quarantine of the downloaded disk image.
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *what) {
  fprintf(stderr, "Flyto2 Runtime: %s: %s\n", what, strerror(errno));
  return 1;
}

// Writes value as one single-quoted shell word.
static void write_quoted(FILE *out, const char *value) {
  fputc('\'', out);
  for (const char *c = value; *c; c++) {
    if (*c == '\'') fputs("'\\''", out);
    else fputc(*c, out);
  }
  fputc('\'', out);
}

int main(void) {
  char raw[PATH_MAX];
  uint32_t size = sizeof raw;
  if (_NSGetExecutablePath(raw, &size) != 0) return fail("executable path");
  char executable[PATH_MAX];
  if (!realpath(raw, executable)) return fail("executable path");

  // <app>/Contents/MacOS/<name> -> <app>/Contents
  char *slash = strrchr(executable, '/');
  if (!slash) return fail("bundle layout");
  *slash = '\0';
  slash = strrchr(executable, '/');
  if (!slash) return fail("bundle layout");
  *slash = '\0';
  char launcher[PATH_MAX];
  snprintf(launcher, sizeof launcher, "%s/Resources/runtime/Flyto2 Runtime.command", executable);

  const char *home = getenv("HOME");
  if (!home || !*home) {
    struct passwd *user = getpwuid(getuid());
    if (!user) return fail("home directory");
    home = user->pw_dir;
  }
  char directory[PATH_MAX];
  snprintf(directory, sizeof directory, "%s/Library/Application Support/Flyto2 Runtime", home);
  char parent[PATH_MAX];
  snprintf(parent, sizeof parent, "%s/Library/Application Support", home);
  mkdir(parent, 0700);
  if (mkdir(directory, 0700) != 0 && errno != EEXIST) return fail(directory);

  char script[PATH_MAX];
  snprintf(script, sizeof script, "%s/Open Flyto2 Runtime.command", directory);
  FILE *out = fopen(script, "w");
  if (!out) return fail(script);
  fputs("#!/bin/bash\nexec ", out);
  write_quoted(out, launcher);
  fputs(" app\n", out);
  if (fclose(out) != 0) return fail(script);
  if (chmod(script, 0700) != 0) return fail(script);

  execl("/usr/bin/open", "open", "-a", "Terminal", script, (char *)NULL);
  return fail("open Terminal");
}
