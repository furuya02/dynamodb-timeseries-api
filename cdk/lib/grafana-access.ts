import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { PROJECT } from './constants';
import type { DeployOptions } from './options';

/**
 * IAM 認証のとき、Grafana に渡す最小権限（API を呼ぶ権限だけ）。
 * 管理ポリシーを作り、-c grafanaUser で IAM ユーザー、-c grafanaRoleTrust で Assume Role 用のロールに付ける
 */
export function createGrafanaAccess(scope: Construct, invokeStatements: iam.PolicyStatement[], o: DeployOptions): void {
  const policy = new iam.ManagedPolicy(scope, 'GrafanaInvokePolicy', {
    managedPolicyName: `${PROJECT}-invoke`,
    // IAM の description は Latin-1 の文字だけ使える（日本語は CloudFormation の検証で拒否される）
    description: 'Allows Grafana (Infinity) to call dynamodb-timeseries-api',
    statements: invokeStatements,
  });
  new cdk.CfnOutput(scope, 'GrafanaPolicyArn', {
    value: policy.managedPolicyArn,
    description: 'EC2 のロールなど、既存のロールに付ける場合はこのポリシーを使う',
  });

  if (o.grafanaUser) {
    // アクセスキーは CloudFormation に残さないよう作らない。出力のコマンドで作成する
    const user = new iam.User(scope, 'GrafanaUser', { userName: `${PROJECT}-grafana`, managedPolicies: [policy] });
    new cdk.CfnOutput(scope, 'GrafanaUserName', { value: user.userName });
    new cdk.CfnOutput(scope, 'CreateAccessKeyCommand', { value: `aws iam create-access-key --user-name ${user.userName}` });
  }
  if (o.grafanaRoleTrust) {
    const role = new iam.Role(scope, 'GrafanaRole', {
      roleName: `${PROJECT}-grafana`,
      assumedBy: new iam.ArnPrincipal(o.grafanaRoleTrust),
      managedPolicies: [policy],
      description: 'Assumed by Grafana (Infinity) to call dynamodb-timeseries-api',
    });
    new cdk.CfnOutput(scope, 'GrafanaRoleArn', { value: role.roleArn });
  }
}
