build-ApiFunction:
	python -m pip install --quiet --only-binary=:all: --platform manylinux2014_x86_64 --implementation cp --python-version 3.12 --abi cp312 --target "$(ARTIFACTS_DIR)" -r requirements.txt
	cp app.py rules.py "$(ARTIFACTS_DIR)"

build-BroadcastFunction:
	cp broadcast.py "$(ARTIFACTS_DIR)"
