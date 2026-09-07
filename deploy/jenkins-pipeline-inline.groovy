pipeline {
    agent any

    parameters {
        string(name: 'BRANCH_TAG', defaultValue: 'terraform-dr', description: 'Branch/tag to build')
    }

    environment {
        REPO_URL         = 'https://gitlab.example.com/your-org/devops/infra/env-files/terra-dr-activity.git'
        REPO_CREDENTIALS = 'Gitlab_1'
        APP_NAME         = 'teraform-dr'
        IMAGE_REGISTRY   = '<your-registry>'
        IMAGE_NAME       = 'deployment-dashboard/teraform-dr'

        // Redacted for public showcase repo -- was a live MS Teams incoming webhook URL.
        MS_TEAMS_WEBHOOK = credentials('ms-teams-webhook-url')
    }

    stages {
        stage('Validate Input') {
            steps {
                script {
                    if (!params.BRANCH_TAG?.trim()) {
                        error "Branch/tag value is required"
                    }
                    echo "Triggered build for: ${params.BRANCH_TAG}"
                }
            }
        }

        stage('Checkout Source') {
            steps {
                script {
                    def ref = params.BRANCH_TAG.trim()
                    // Same tag-vs-branch heuristic as the reference pipeline:
                    // starts with 'v' or a digit -> treated as a tag.
                    def isTag = ref ==~ /^v.*/ || ref ==~ /^[0-9].*/

                    if (isTag) {
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: "refs/tags/${ref}"]],
                            userRemoteConfigs: [[
                                url: env.REPO_URL,
                                credentialsId: env.REPO_CREDENTIALS
                            ]]
                        ])
                        env.BUILD_REF_TYPE = "tag"
                        env.VERSION = ref
                    } else {
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: "*/${ref}"]],
                            userRemoteConfigs: [[
                                url: env.REPO_URL,
                                credentialsId: env.REPO_CREDENTIALS
                            ]]
                        ])
                        env.BUILD_REF_TYPE = "branch"
                        env.VERSION = ref.replaceAll("^origin/", "").replaceAll("/", "-")
                    }
                    echo "Checked out ${env.BUILD_REF_TYPE}: ${env.VERSION}"
                    env.FULL_IMAGE = "${IMAGE_REGISTRY}/${IMAGE_NAME}:${env.VERSION}"
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                sh '''
                echo "Building Docker image: ${FULL_IMAGE}"
                docker build --no-cache -f Dockerfile -t "$FULL_IMAGE" .
                '''
            }
        }

        stage('Push Docker Image') {
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'NewDockerHarbor',
                        usernameVariable: 'HARBOR_USER',
                        passwordVariable: 'HARBOR_PASSWORD'
                    )
                ]) {
                    sh '''
                        echo "${HARBOR_PASSWORD}" | docker login ${IMAGE_REGISTRY} \
                        --username "${HARBOR_USER}" \
                        --password-stdin
                        docker push "$FULL_IMAGE"
                        docker rmi "$FULL_IMAGE" || true
                    '''
                }
            }
        }
    }

    post {
        success {
            sh '''
            curl -H "Content-Type: application/json" -d '{
              "type": "message",
              "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                  "type": "AdaptiveCard",
                  "version": "1.4",
                  "body": [
                    {
                      "type": "TextBlock",
                      "text": "Build Successful",
                      "weight": "Bolder",
                      "size": "Large",
                      "color": "Good"
                    },
                    {
                      "type": "FactSet",
                      "facts": [
                        { "title": "Application:", "value": "${APP_NAME}" },
                        { "title": "Ref:", "value": "${BRANCH_TAG}" },
                        { "title": "Type:", "value": "${BUILD_REF_TYPE}" },
                        { "title": "Build Number:", "value": "${BUILD_NUMBER}" },
                        { "title": "Status:", "value": "SUCCESS" }
                      ]
                    }
                  ]
                }
              }]
            }' "$MS_TEAMS_WEBHOOK"
            '''
        }

        failure {
            sh '''
            curl -H "Content-Type: application/json" -d '{
              "type": "message",
              "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                  "type": "AdaptiveCard",
                  "version": "1.4",
                  "body": [
                    {
                      "type": "TextBlock",
                      "text": "Build Failed",
                      "weight": "Bolder",
                      "size": "Large",
                      "color": "Attention"
                    },
                    {
                      "type": "FactSet",
                      "facts": [
                        { "title": "Application:", "value": "${APP_NAME}" },
                        { "title": "Ref:", "value": "${BRANCH_TAG}" },
                        { "title": "Build Number:", "value": "${BUILD_NUMBER}" },
                        { "title": "Status:", "value": "FAILED" }
                      ]
                    }
                  ]
                }
              }]
            }' "$MS_TEAMS_WEBHOOK"
            '''
        }
    }
}
