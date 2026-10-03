# Debian base (not Amazon Linux) so we get reliable apt access to
# imagemagick/ghostscript/libheif/librsvg/dcraw, adapted to run as a Lambda
# container image via the Lambda Runtime Interface Client (awslambdaric).
#
# NOTE: build context is the `src/` directory (see template.yaml
# Metadata.DockerContext), not this folder, so that `common/` is reachable.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick \
    ghostscript \
    libheif-examples \
    librsvg2-bin \
    dcraw \
    webp \
    && rm -rf /var/lib/apt/lists/*

# Ghostscript/ImageMagick ship a restrictive default policy that blocks
# reading PDF/EPS by default (the 2019 "ImageTragick"-adjacent hardening).
# We re-enable exactly the coders this service needs and cap resource usage
# so a hostile input can't be used for a decompression-bomb style DoS.
COPY convert_worker/policy.xml /etc/ImageMagick-6/policy.xml

ENV LAMBDA_TASK_ROOT=/var/task
WORKDIR ${LAMBDA_TASK_ROOT}

RUN pip install --no-cache-dir --target "${LAMBDA_TASK_ROOT}" awslambdaric boto3

COPY convert_worker/app.py ${LAMBDA_TASK_ROOT}/app.py
COPY common ${LAMBDA_TASK_ROOT}/common

ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["app.handler"]

