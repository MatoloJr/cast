UUID    := display-and-cast@cast.tools
ZIP     := $(UUID).shell-extension.zip
VERSION := $(shell jq -r .version metadata.json 2>/dev/null || echo 0)
HELPER  := helpers/cast-helper
VENV    := $(or $(XDG_DATA_HOME),$(HOME)/.local/share)/cast-display/cast-helper/venv
PYTHON  := $(firstword $(wildcard $(VENV)/bin/python) python3)
RELEASE := cast-display-$(VERSION)

# Files that make up the extension itself. The helper is deliberately not
# among them: extensions.gnome.org reviews JavaScript and shipping a Python
# daemon inside the zip is not something a reviewer can sign off on. The
# release tarball carries both.
EXT_SOURCES := lib ui schemas stylesheet.css LICENSE

.PHONY: help install helper uninstall test lint test-py test-js schema pack release clean

help:
	@echo "Cast Display $(VERSION)"
	@echo
	@echo "  make test       - pytest + node --test + eslint + ruff + schema check"
	@echo "  make lint       - eslint + ruff only"
	@echo "  make install    - install the extension and the helper"
	@echo "  make helper     - install the helper only"
	@echo "  make uninstall  - remove everything"
	@echo "  make pack       - $(ZIP), extension only, for extensions.gnome.org"
	@echo "  make release    - $(RELEASE).tar.gz, extension + helper + installer"
	@echo "  make clean      - remove build output"

install:
	./install.sh

helper:
	./install.sh --helper-only

uninstall:
	./install.sh --uninstall

# -- checks ----------------------------------------------------------------

test: schema test-py test-js lint
	@echo
	@echo "All checks passed."

test-py:
	@echo "==> pytest"
	cd $(HELPER) && $(PYTHON) -m pytest tests/ -q

test-js:
	@echo "==> node --test (layout arithmetic, tile actions, dialog metrics)"
	node --test tests/layout.test.js tests/dialog.test.js

schema:
	@echo "==> schema"
	glib-compile-schemas --strict --dry-run schemas/

lint:
	@echo "==> eslint"
	@if [ -x node_modules/.bin/eslint ]; then \
	  node_modules/.bin/eslint . ; \
	else \
	  echo "   (skipped: run 'npm install --no-save eslint@9' for the JS lint)" ; \
	fi
	@echo "==> ruff"
	@if $(PYTHON) -c "import ruff" 2>/dev/null || [ -x $(VENV)/bin/ruff ]; then \
	  $(VENV)/bin/ruff check $(HELPER) ; \
	else \
	  echo "   (skipped: pip install ruff for the Python lint)" ; \
	fi

# -- packaging -------------------------------------------------------------

pack: clean schema
	glib-compile-schemas schemas/
	gnome-extensions pack . --force \
	  $(foreach src,$(EXT_SOURCES),--extra-source=$(src))
	@echo "Built $(ZIP) (extension only, no helper)"
	@unzip -l $(ZIP) | grep -q 'helpers/' \
	  && { echo "ERROR: the helper leaked into the zip" >&2; exit 1; } \
	  || echo "Verified: no helper inside the zip"

release: clean schema
	@rm -rf build/$(RELEASE)
	@mkdir -p build/$(RELEASE)
	cp -a metadata.json extension.js prefs.js stylesheet.css LICENSE README.md \
	      index.html \
	      Makefile install.sh install-helper.sh \
	      lib ui schemas docs build/$(RELEASE)/
	cp -a $(HELPER) build/$(RELEASE)/helpers-cast-helper
	@mkdir -p build/$(RELEASE)/helpers
	@mv build/$(RELEASE)/helpers-cast-helper build/$(RELEASE)/helpers/cast-helper
	@find build/$(RELEASE) -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@find build/$(RELEASE) -name '*.pyc' -delete 2>/dev/null || true
	@rm -f build/$(RELEASE)/schemas/gschemas.compiled
	tar -C build -czf $(RELEASE).tar.gz $(RELEASE)
	@rm -rf build/$(RELEASE)
	@echo "Built $(RELEASE).tar.gz"

clean:
	rm -f $(ZIP) cast-display-*.tar.gz
	rm -rf build
	find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -prune -exec rm -rf {} + 2>/dev/null || true
	rm -f schemas/gschemas.compiled
