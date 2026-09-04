UUID := display-and-cast@cast.tools
ZIP  := $(UUID).shell-extension.zip

.PHONY: help install uninstall pack clean helper

help:
	@echo "Targets:"
	@echo "  make install    - run ./install.sh (extension + helper)"
	@echo "  make helper     - install cast helper only"
	@echo "  make uninstall  - remove extension + helper"
	@echo "  make pack       - build $(ZIP) for GitHub Releases"
	@echo "  make clean      - remove zip and pycache"

install:
	./install.sh

helper:
	./install.sh --helper-only

uninstall:
	./install.sh --uninstall

pack: clean
	glib-compile-schemas schemas/
	gnome-extensions pack . --force \
	  --extra-source=lib \
	  --extra-source=ui \
	  --extra-source=helpers \
	  --extra-source=install.sh \
	  --extra-source=install-helper.sh \
	  --extra-source=README.md \
	  --extra-source=LICENSE \
	  --extra-source=Makefile
	@echo "Built $(ZIP)"

clean:
	rm -f $(ZIP)
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -f schemas/gschemas.compiled
