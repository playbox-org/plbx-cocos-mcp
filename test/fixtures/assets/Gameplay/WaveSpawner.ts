import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('WaveSpawner')
export class WaveSpawner extends Component {
    @property
    waveSize: number = 3;
}
