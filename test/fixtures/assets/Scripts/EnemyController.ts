import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('EnemyController')
export class EnemyController extends Component {
    @property
    health: number = 100;

    @property
    damage: number = 25;
}
