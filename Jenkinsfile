// Unit tests run HERE (not on GitHub Actions) on every dev-environment build
// (DEPLOY_ENV == 'dev': any branch except main, plus PR builds), before Build. A failing test stops
// the deploy. PR builds only test (never build/push/sync/migrate/deploy). main/prod never runs tests.

// Build result -> GitHub commit status (needs only repo:status on the token), so pass/fail is
// visible on the commit / PR without opening Jenkins. Context: jenkins/dev, jenkins/prod, jenkins/pr.
// Never fails the build: any error here is logged and ignored.
def ghStatus(String state, String desc) {
    try {
        def repo = (env.GIT_URL ?: '').replaceFirst(/^.*github\.com[:\/]/, '').replaceFirst(/\.git$/, '')
        if (!repo) { echo 'GitHub status skipped: GIT_URL not set'; return }
        // PR builds check out a local merge commit GitHub doesn't know; report on the PR head (HEAD^2).
        def sha = env.CHANGE_ID ?
            sh(returnStdout: true, script: 'git rev-parse -q --verify HEAD^2 || git rev-parse HEAD').trim() :
            env.GIT_COMMIT
        def ctx = env.CHANGE_ID ? 'jenkins/pr' : "jenkins/${env.DEPLOY_ENV}"
        def safe = desc.replaceAll(/["\\\n\r]/, ' ').take(140)
        writeFile file: '.ci-status.json',
            text: "{\"state\":\"${state}\",\"context\":\"${ctx}\",\"description\":\"${safe}\"}"
        withCredentials([string(credentialsId: 'github-token-GHCR', variable: 'GH_STATUS_TOKEN')]) {
            sh label: 'GitHub commit status', script: """
                curl -sS -o /dev/null -w 'GitHub status (${state}) HTTP %{http_code}\\n' -X POST \
                    -H "Authorization: token \$GH_STATUS_TOKEN" \
                    -H 'Accept: application/vnd.github+json' \
                    --data @.ci-status.json \
                    https://api.github.com/repos/${repo}/statuses/${sha} || true
                rm -f .ci-status.json
            """
        }
    } catch (e) {
        echo "GitHub status skipped: ${e.message}"
    }
}

pipeline {
    agent any
    
    tools {
        nodejs 'node-25'
    }
    
    environment {
        REGISTRY     = 'ghcr.io'
        ORG_NAME     = 'xclusively'
        SERVICE_NAME = 'ffmpeg-service'
        IMAGE_TAG    = "${env.GIT_COMMIT.take(7)}"
        DEPLOY_ENV   = "${env.BRANCH_NAME == 'main' ? 'prod' : 'dev'}"
        FULL_IMAGE   = "${REGISTRY}/${ORG_NAME}/${DEPLOY_ENV}/${SERVICE_NAME}:${IMAGE_TAG}"
        CONTAINER_NAME = "${DEPLOY_ENV}-${SERVICE_NAME}"
        // ARCH-007 Phase B toggle (dev): leave xclusively-network after edge networks are in place.
        ARCH007_ISOLATE = 'false'
    }
    
    stages {
        stage('Checkout') {
            steps {
                script { env.LAST_STAGE = env.STAGE_NAME }
                checkout scm
                script { ghStatus('pending', "${env.CHANGE_ID ? 'PR tests' : env.DEPLOY_ENV + ' deploy'} running (${IMAGE_TAG})") }
            }
        }
        
        // Every dev-environment build (any branch except main, and PR builds). Runs BEFORE Build, so a
        // red test stops the pipeline and dev keeps the old container. main/prod never matches.
        // Throwaway node:20 container (no DB: this service has no migrations) on a per-build network (never
        // xclusively-network). Nothing from the server .env / Infisical is used.
        stage('Test (dev only)') {
            when {
                expression { env.DEPLOY_ENV == 'dev' }
            }
            options {
                timeout(time: 25, unit: 'MINUTES')
            }
            steps {
                script { env.LAST_STAGE = env.STAGE_NAME }
                sh '''
                    set -eu
                    # Names derived from BUILD_TAG (unique per build); the post block recomputes them identically.
                    TAG=$(printf '%s' "$BUILD_TAG" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g' | tail -c 41)
                    NODE="ci-node-$TAG"


                    # Test mode. Base commit to diff against:
                    #   PR build (merge commit)  -> HEAD^1 (target tip)
                    #   branch build             -> last green build of this branch (GIT_PREVIOUS_SUCCESSFUL_COMMIT)
                    #   neither available        -> full suite
                    # Global-impact changes force the full suite; otherwise only tests related to changed files.
                    MODE=full
                    BASE=""
                    PREV="${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}"
                    if git rev-parse -q --verify HEAD^2 >/dev/null; then
                        BASE=$(git rev-parse HEAD^1)
                    elif [ -n "$PREV" ] && git cat-file -e "$PREV^{commit}" 2>/dev/null; then
                        BASE="$PREV"
                    fi
                    if [ -n "$BASE" ]; then
                        CHANGED=$(git diff --name-only "$BASE" HEAD)
                        echo "Files changed vs $BASE:"
                        echo "$CHANGED"
                        if echo "$CHANGED" | grep -Eq '^(package[.]json|package-lock[.]json|jest[.]config[.]js|src/config/|[.]github/|Jenkinsfile)'; then
                            echo "Global-impact file changed - forcing full suite."
                        else
                            MODE=changed
                        fi
                    else
                        echo "No base commit (first build or history missing) - running full suite."
                    fi
                    echo "Test mode selected: $MODE"

                    # Test on the same Node major as production (the service's Dockerfile FROM node:<major>).
                    NODE_IMAGE=$(grep -m1 -oE '^FROM node:[0-9]+' Dockerfile | cut -d' ' -f2 || true)
                    NODE_IMAGE="${NODE_IMAGE:-node:24}"
                    echo "Test image: $NODE_IMAGE (from Dockerfile)"
                    mkdir -p "$HOME/.npm-ci-cache"
                    docker run --rm --name "$NODE" \
                        -u "$(id -u):$(id -g)" \
                        -e HOME=/tmp -e CI=true \
                        -e JEST_MODE="$MODE" -e JEST_BASE="$BASE" \
                        -v "$WORKSPACE:/app" -w /app \
                        -v "$HOME/.npm-ci-cache:/tmp/.npm" \
                        "$NODE_IMAGE" sh -c '
                            set -eu
                            git config --global --add safe.directory /app
                            npm ci --prefer-offline --no-audit --no-fund

                            echo "Running tests in mode: $JEST_MODE"
                            # Output captured to .ci-jest.log so the summary line can go to GitHub status.
                            rc=0
                            if [ "$JEST_MODE" = "changed" ]; then
                                npx jest --ci --maxWorkers=2 --forceExit --cacheDirectory=.jest-cache --changedSince="$JEST_BASE" --passWithNoTests > .ci-jest.log 2>&1 || rc=$?
                            else
                                npx jest --ci --maxWorkers=2 --forceExit --cacheDirectory=.jest-cache > .ci-jest.log 2>&1 || rc=$?
                            fi
                            cat .ci-jest.log
                            exit $rc
                        '
                '''
            }
            post {
                always {
                    script {
                        // e.g. "Tests: 1 failed, 238 passed | suites: 1 failed | foo.test.js" (first failing file).
                        env.TEST_SUMMARY = sh(returnStdout: true, script: '''
                            L=.ci-jest.log
                            [ -f "$L" ] || exit 0
                            T=$(grep -m1 -E '^Tests:' "$L" | sed -E 's/, [0-9]+ total//' | tr -s ' ' || true)
                            S=$(grep -m1 -E '^Test Suites:.*failed' "$L" | grep -oE '[0-9]+ failed' | head -1 || true)
                            F=$(grep -m1 -E '^FAIL ' "$L" | awk '{print $2}' | sed 's#.*/##' || true)
                            OUT="$T"
                            [ -n "$S" ] && OUT="$OUT | suites: $S"
                            [ -n "$F" ] && OUT="$OUT | $F"
                            printf '%s' "$OUT"
                        ''').trim()
                        sh 'rm -f .ci-jest.log'
                    }
                    sh '''
                        TAG=$(printf '%s' "$BUILD_TAG" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g' | tail -c 41)
                        docker rm -f "ci-node-$TAG" >/dev/null 2>&1 || true
                    '''
                }
            }
        }

        stage('Secret Scan') {
            when { not { changeRequest() } }
            steps {
                script { env.LAST_STAGE = env.STAGE_NAME }
                sh '''
                    echo "🔒 Scanning working tree for verified secrets (TruffleHog)..."
                    docker run --rm \
                        -v "$WORKSPACE:/repo:ro" \
                        trufflesecurity/trufflehog:latest \
                        filesystem /repo \
                        --results=verified \
                        --fail
                '''
            }
        }

        stage('Build & Push') {
            when { not { changeRequest() } }
            steps {
                script { env.LAST_STAGE = env.STAGE_NAME }
                sh "docker build -t ${FULL_IMAGE} ."
                withCredentials([string(credentialsId: 'github-token-GHCR', variable: 'GITHUB_TOKEN')]) {
                    sh """
                        echo \$GITHUB_TOKEN | docker login ${REGISTRY} -u ${ORG_NAME} --password-stdin
                        docker push ${FULL_IMAGE}
                    """
                }
            }
        }
        
        stage('Deploy') {
            when { not { changeRequest() } }
            steps {
                script { env.LAST_STAGE = env.STAGE_NAME }
                script {
                    sh """
                        # 1. Pull the new image
                        docker pull ${FULL_IMAGE}
                        
                        # 2. Backup current container (if it exists) by renaming it
                        if [ \$(docker ps -aq -f name=^/${CONTAINER_NAME}\$) ]; then
                            echo "Backing up current container..."
                            docker stop ${CONTAINER_NAME} || true
                            docker rename ${CONTAINER_NAME} ${CONTAINER_NAME}-backup
                        fi
                        
                        # 3. Start the NEW container (no Docker socket: ffmpeg runs in-image)
                        docker run -d \
                            --name ${CONTAINER_NAME} \
                            --network xclusively-network \
                            --env-file /home/devops/xclusively/${SERVICE_NAME}/.env \
                            -v /home/devops/xclusively/${SERVICE_NAME}/.env:/app/.env \
                            --restart unless-stopped \
                            ${FULL_IMAGE}
                        
                        # ARCH-007 app-tier segmentation — per-call-edge networks, generated from
                        # infrastructure/arch007/networks.json (gen_networks.py). Phase A (dev only): ALSO join
                        # this service's edge networks — additive, no behaviour change. Phase B: set
                        # ARCH007_ISOLATE=true (via PR) to leave the shared xclusively-network, once every peer
                        # and infra container (nginx, blackbox, postgres, redis) is on its networks.
                        if [ "${DEPLOY_ENV}" = "dev" ]; then
                            for spec in \
                                xce-api-gateway--ffmpeg-service:10.77.0.96/28 \
                                xce-ffmpeg-service--post-service:10.77.1.96/28; do
                                net="${DEPLOY_ENV}-\${spec%%:*}"; subnet="\${spec#*:}"
                                docker network inspect "\$net" >/dev/null 2>&1 || docker network create --subnet "\$subnet" "\$net" >/dev/null 2>&1 || docker network inspect "\$net" >/dev/null
                                docker network connect "\$net" ${CONTAINER_NAME} 2>/dev/null || true
                            done
                            if [ "${ARCH007_ISOLATE}" = "true" ]; then
                                docker network disconnect xclusively-network ${CONTAINER_NAME} || true
                            fi
                        fi

                        # 4. Verification/Health Check
                        echo "Waiting for health check..."
                        sleep 10
                        if docker ps -f name=^/${CONTAINER_NAME}\$ --format '{{.Status}}' | grep -q "Up"; then
                            echo "✅ New container is healthy. Removing backup."
                            docker rm -f ${CONTAINER_NAME}-backup || true
                        else
                            echo "❌ New container failed! Triggering rollback..."
                            exit 1
                        fi
                    """
                }
            }
        }
    }
    
    post {
        success {
            script {
                def t = env.TEST_SUMMARY ? " | ${env.TEST_SUMMARY}" : ''
                ghStatus('success', env.CHANGE_ID ? "PR tests passed${t}" : "${env.DEPLOY_ENV} deployed ${IMAGE_TAG}${t}")
            }
        }

        aborted {
            script { ghStatus('error', "${env.DEPLOY_ENV} aborted/timed out at ${env.LAST_STAGE ?: 'start'}") }
        }

        failure {
            script {
                def t = env.TEST_SUMMARY ? " | ${env.TEST_SUMMARY}" : ''
                def kept = env.CHANGE_ID ? '' : ' - old container kept/restored'
                ghStatus('failure', "${env.CHANGE_ID ? 'PR' : env.DEPLOY_ENV} FAILED at ${env.LAST_STAGE ?: 'start'}${t}${kept}")
                if (env.CHANGE_ID) {
                    echo 'PR build: nothing to roll back'
                    return
                }
            echo "🚨 Deployment failed! Rolling back to previous container..."
            sh """
                # Roll back ONLY what this run changed. A failure before Deploy (secret scan,
                # build, push, env sync) never touched the running container — removing it
                # anyway took dev-next-frontend down on 2026-10-08 (build failed, no backup).
                if [ \$(docker ps -aq -f name=^/${CONTAINER_NAME}-backup\$) ]; then
                    # Deploy started: drop the failed new container, restore the previous one.
                    docker rm -f ${CONTAINER_NAME} || true
                    docker rename ${CONTAINER_NAME}-backup ${CONTAINER_NAME}
                    docker start ${CONTAINER_NAME}
                    echo "✅ Rollback complete: Previous version restored."
                elif [ "\$(docker inspect -f '{{.Config.Image}}' ${CONTAINER_NAME} 2>/dev/null)" = "${FULL_IMAGE}" ]; then
                    # First deploy of this service failed: nothing older to restore.
                    docker rm -f ${CONTAINER_NAME} || true
                    echo "⚠️ No backup found to rollback to (first deploy) — failed container removed."
                else
                    echo "ℹ️ Failed before Deploy — running container left untouched."
                fi
                
                # Cleanup the failed image to save space
                docker rmi ${FULL_IMAGE} || true
            """
            }
        }
        
        always {
            script {
                if (env.CHANGE_ID) {
                    echo 'PR build: skipping image cleanup'
                    return
                }
                try {
                    sh """
                        echo "Cleaning up dangling images..."
                        docker image prune -f --filter 'dangling=true' || true
                        
                        # Keep only the 3 most recent images of this service
                        docker images ${REGISTRY}/${ORG_NAME}/${DEPLOY_ENV}/${SERVICE_NAME} -q | tail -n +4 | xargs -r docker rmi -f || true
                    """
                } catch (Exception e) {
                    echo "Cleanup warning: ${e.message}"
                }
            }
        }
    }
}