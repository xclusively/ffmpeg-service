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
                checkout scm
            }
        }
        
        stage('Secret Scan') {
            steps {
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
            steps {
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
            steps {
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
                        
                        # 3. Ensure shared video scratch directory exists on the host
                        mkdir -p /tmp/xclusively-videos

                        # 4. Start the NEW container
                        docker run -d \
                            --name ${CONTAINER_NAME} \
                            --network xclusively-network \
                            --env-file /home/devops/xclusively/${SERVICE_NAME}/.env \
                            --restart unless-stopped \
                            -v /var/run/docker.sock:/var/run/docker.sock:ro \
                            -v /tmp/xclusively-videos:/tmp/videos \
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

                        # 5. Verification/Health Check
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
        failure {
            echo "🚨 Deployment failed! Rolling back to previous container..."
            sh """
                # Stop and remove the failed new container
                docker stop ${CONTAINER_NAME} || true
                docker rm -f ${CONTAINER_NAME} || true
                
                # Restore the backup container if it exists
                if [ \$(docker ps -aq -f name=^/${CONTAINER_NAME}-backup\$) ]; then
                    docker rename ${CONTAINER_NAME}-backup ${CONTAINER_NAME}
                    docker start ${CONTAINER_NAME}
                    echo "✅ Rollback complete: Previous version restored."
                else
                    echo "⚠️ No backup found to rollback to."
                fi
                
                # Cleanup the failed image to save space
                docker rmi ${FULL_IMAGE} || true
            """
        }
        
        always {
            script {
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